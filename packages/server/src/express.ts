import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HEADERS } from "@hexera/core";
import { HexeraMerchant, type MerchantOptions } from "./merchant";

export interface PaywallRouteOptions {
  /** price in whole voucher units (1 unit = 0.001 USDC) */
  price: number;
  description?: string;
}

/**
 * Express middleware: `app.get("/article/:id", hexeraPaywall(merchant, { price: 3 }), handler)`.
 *
 * For POST bodies, keep the raw bytes for the request hash:
 *   app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
 */
export function hexeraPaywall(merchant: HexeraMerchant | MerchantOptions, route: PaywallRouteOptions): RequestHandler {
  const m = merchant instanceof HexeraMerchant ? merchant : new HexeraMerchant(merchant);
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      const result = await m.handle(
        {
          method: req.method,
          pathWithQuery: req.originalUrl,
          url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
          body: raw ? new Uint8Array(raw) : "",
          header: (n) => req.get(n),
        },
        route.price,
        route.description,
      );
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      if (result.kind === "paid") {
        res.locals.hexera = result.settlement;
        return next();
      }
      return res.status(result.status).json(result.body);
    } catch (e) {
      next(e);
    }
  };
}

/** CORS headers browsers need to read/send x402 headers cross-origin. */
export function x402Cors(): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", req.get("origin") ?? "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${HEADERS.signature}, X-PAYMENT`);
    res.setHeader("Access-Control-Expose-Headers", `${HEADERS.required}, ${HEADERS.response}`);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}
