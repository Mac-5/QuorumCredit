import type { IncomingMessage, ServerResponse } from "node:http";
import { issueToken } from "../auth/tokens.js";
import { metrics } from "./metricsRegistry.js";
import * as insuranceMarketplace from "../insurance-marketplace.js";

export interface RouteContext {
  authSecret: string;
  tokenTtlSeconds: number;
}

interface TokenRequestBody {
  apiKey?: string;
  borrower?: string;
}

/** Minimal router for the handful of REST endpoints this service exposes — not
 * pulling in Express for three routes. */
export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
): void {
  const url = new URL(req.url ?? "", "http://internal");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(metrics.toPrometheusText());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/token") {
    readJsonBody(req)
      .then((body: TokenRequestBody) => {
        // NOTE: this issues a token to anyone who asks with any apiKey string — real
        // deployments must swap in a genuine credential check (e.g. verifying apiKey
        // against a provisioned-keys store) before going to production. Wiring that
        // check is intentionally left as a single, obvious seam (this block) rather
        // than left implicit, since this repo has no existing API-key store to
        // integrate against.
        if (!body.apiKey) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "apiKey required" }));
          return;
        }
        const issued = issueToken(ctx.authSecret, body.apiKey, ctx.tokenTtlSeconds, body.borrower);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(issued));
      })
      .catch(() => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid request body" }));
      });
    return;
  }

  // Issue #1174: Insurance marketplace endpoints
  if (req.method === "GET" && url.pathname === "/insurance/providers") {
    const providers = insuranceMarketplace.getActiveProviders();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/insurance/products") {
    const products = insuranceMarketplace.getActiveProducts();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ products }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/insurance/quotes") {
    const params = url.searchParams;
    const loanId = parseInt(params.get("loanId") || "0", 10);
    const borrower = params.get("borrower") || "";
    const loanAmount = parseInt(params.get("loanAmount") || "0", 10);
    const token = params.get("token") || "USDC";

    if (!loanId || !borrower || !loanAmount) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required parameters: loanId, borrower, loanAmount" }));
      return;
    }

    insuranceMarketplace
      .generateInsuranceQuotes(loanId, borrower, loanAmount, token)
      .then((quotes) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ quotes }));
      })
      .catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate quotes", details: error.message }));
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/insurance/quote") {
    const quoteId = url.searchParams.get("quoteId") || "";
    const quote = insuranceMarketplace.getQuote(quoteId);

    if (!quote) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Quote not found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ quote }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/insurance/claim") {
    readJsonBody(req)
      .then((body: Record<string, unknown>) => {
        const loanId = body.loanId as number;
        const borrower = body.borrower as string;
        const productId = body.productId as string;
        const claimAmount = body.claimAmount as number;

        if (!loanId || !borrower || !productId || !claimAmount) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields" }));
          return;
        }

        const claim = insuranceMarketplace.submitClaim(loanId, borrower, productId, claimAmount);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ claim }));
      })
      .catch(() => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request body" }));
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/insurance/claim") {
    const claimId = url.searchParams.get("claimId") || "";
    const claim = insuranceMarketplace.getClaim(claimId);

    if (!claim) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Claim not found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ claim }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/insurance/stats") {
    const stats = insuranceMarketplace.getMarketplaceStats();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ stats }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function readJsonBody(req: IncomingMessage): Promise<TokenRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
