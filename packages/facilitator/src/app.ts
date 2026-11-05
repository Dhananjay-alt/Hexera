import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { HexeraPaymentPayload, HexeraRequirements } from "@hexera/core";
import { HttpError } from "./errors";
import type { Facilitator } from "./service";

export async function buildApp(f: Facilitator, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "bad_request", message: err.message });
    f.log.error(err.stack ?? err.message);
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  const requireAdmin = (h: string | undefined) => {
    if (h !== `Bearer ${f.cfg.adminToken}`) throw new HttpError(401, "unauthorized", "admin token required");
  };

  // ---- public ----
  app.get("/", async () => ({ name: "hexera-facilitator", scheme: "hexera-ecash", docs: "/supported" }));
  app.get("/supported", async () => f.supported());
  app.get("/merchants", async () => ({ merchants: f.merchants() }));
  app.get("/books", async () => f.books());

  // ---- client ----
  app.post("/issue", async (req) => f.issue(req.body as Parameters<Facilitator["issue"]>[0]));
  app.post("/exchange", async (req) => f.exchange(req.body as Parameters<Facilitator["exchange"]>[0]));

  // ---- merchant (x402 facilitator API) ----
  type VS = { paymentPayload: HexeraPaymentPayload; paymentRequirements: HexeraRequirements };
  app.post("/verify", async (req) => {
    const b = req.body as VS;
    return f.verify(b?.paymentPayload, b?.paymentRequirements);
  });
  app.post("/settle", async (req) => {
    const b = req.body as VS;
    return f.settle(b?.paymentPayload, b?.paymentRequirements);
  });

  // ---- local mode: mirror-node shaped reads + test wallet ----
  const local = f.local;
  if (local) {
    app.get("/api/v1/topics/:id/messages", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!local.hasTopic(id)) return reply.code(404).send({ _status: { messages: [{ message: "Not found" }] } });
      const q = req.query as { limit?: string; sequencenumber?: string };
      const limit = Math.min(Number(q.limit ?? 25), 100);
      const after = Number((q.sequencenumber ?? "gt:0").replace(/^gt:/, "")) || 0;
      const messages = local.topicMessages(id, after, limit);
      const last = messages.at(-1);
      const more = last && local.topicMessages(id, last.sequence_number, 1).length > 0;
      return {
        messages,
        links: { next: more ? `/api/v1/topics/${id}/messages?limit=${limit}&order=asc&sequencenumber=gt:${last!.sequence_number}` : null },
      };
    });
    app.get("/api/v1/transactions/:id", async (req, reply) => {
      const tx = local.transaction((req.params as { id: string }).id);
      if (!tx) return reply.code(404).send({ _status: { messages: [{ message: "Not found" }] } });
      return { transactions: [tx] };
    });
    app.get("/api/v1/accounts/:id/tokens", async (req) => ({ tokens: local.tokenBalances((req.params as { id: string }).id) }));

    /** Get-or-create a named test account and top it up with test USDC. */
    app.post("/local/faucet", async (req) => {
      const { name, amountBase } = req.body as { name: string; amountBase?: string };
      if (!name || !/^[a-z0-9-]{1,32}$/.test(name)) throw new HttpError(400, "bad_name", "name: [a-z0-9-]{1,32}");
      const account = local.entity(`account:user:${name}`);
      const want = BigInt(amountBase ?? "5000000");
      const bal = local.balance(account, f.ids.token);
      if (bal < want) local.mint(f.ids.token, account, want - bal);
      return { account, balanceBase: local.balance(account, f.ids.token).toString(), token: f.ids.token };
    });
    /** Stands in for the user's wallet signing an HTS transfer to the treasury. */
    app.post("/local/deposit", async (req) => {
      const { account, amountBase } = req.body as { account: string; amountBase: string };
      try {
        const txId = local.userTransfer(f.ids.token, account, f.ids.treasury, BigInt(amountBase), "hexera deposit");
        return { transactionId: txId };
      } catch (e) {
        throw new HttpError(400, "transfer_failed", (e as Error).message);
      }
    });
    app.get("/local/balance/:account", async (req) => {
      const { account } = req.params as { account: string };
      return { account, balanceBase: local.balance(account, f.ids.token).toString() };
    });
  }

  return app;
}
