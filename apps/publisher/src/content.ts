export interface Article {
  slug: string;
  title: string;
  teaser: string;
  body: string[];
  price: number; // units of 0.001 USDC
}

export interface Publication {
  id: string;
  name: string;
  tagline: string;
  articles: Article[];
}

export const PUBLICATIONS: Record<string, Publication> = {
  "daily-ledger": {
    id: "daily-ledger",
    name: "The Daily Ledger",
    tagline: "Long reads on money, law and health.",
    articles: [
      {
        slug: "consensus-without-surveillance",
        title: "Consensus without surveillance",
        teaser: "Public ledgers made payments auditable. They also made them readable by anyone.",
        price: 3,
        body: [
          "Every public-ledger payment is a postcard: anyone can read the sender, the recipient, the amount and the time.",
          "For a coffee, that's harmless. For a pay-per-article reader, it is a reading history published forever.",
          "Card networks never exposed this. The question is whether open payment rails can match that privacy without giving up auditability.",
        ],
      },
      {
        slug: "what-your-api-bills-say",
        title: "What your API bills say about you",
        teaser: "Health, legal and finance APIs reveal more through who pays them than through what they return.",
        price: 2,
        body: [
          "A query to a symptom checker, a tenancy-law database, a bankruptcy calculator: each is a sentence about the person paying.",
          "When per-request payments land on a public chain, those sentences become a diary anyone can read.",
        ],
      },
      {
        slug: "blind-signatures-explained",
        title: "Blind signatures, explained in five minutes",
        teaser: "David Chaum's 1982 trick, standardised as RFC 9474, is back.",
        price: 1,
        body: [
          "The signer signs a message it cannot read. The holder later reveals the message and signature; the signer can verify it but cannot tell when it signed it.",
          "That's all ecash needs: a bank that can check a coin is real, but not whose it was.",
        ],
      },
    ],
  },
  "quant-feed": {
    id: "quant-feed",
    name: "Quant Feed",
    tagline: "Market data that doesn't leak your strategy.",
    articles: [
      {
        slug: "hbar-orderbook-snapshot",
        title: "HBAR order-book snapshot",
        teaser: "Top-of-book depth across venues, refreshed every minute.",
        price: 5,
        body: [
          "Best bid / ask spread: 0.12%. Depth within 1%: 2.4M HBAR bid, 2.1M HBAR ask.",
          "Who bought this snapshot, and how often, is nobody's business — least of all a competitor watching the chain.",
        ],
      },
      {
        slug: "stablecoin-flows-weekly",
        title: "Stablecoin flows, weekly",
        teaser: "Net USDC mint/burn and bridge flows on Hedera.",
        price: 4,
        body: ["Net mint: +3.2M USDC. Largest single bridge-in: 410k USDC.", "This report costs 0.004 USDC. Pay per read, no subscription, no account."],
      },
    ],
  },
};
