import dotenv from "dotenv";
dotenv.config();
import { RPCTransaction, SolanaBlockStreamer } from "@biqprotocol/biq-streamer";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: Unreachable code error
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

async function doWork() {

  const blockStreamer = new SolanaBlockStreamer({
    standardRPC: process.env.RPC,
    accounts: [
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // PUMP_PROGRAM
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // RAYDIUM_LP_PROGRAM
      "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // RAYDIUM_CLMMV3_PROGRAM
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // WHIRLPOOL_PROGRAM
      "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", // LIFINITY_V2_PROGRAM
      "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // METEORA_AMM_PROGRAM
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // METEORA_CLMM_PROGRAM
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // JUPITER_V6_PROGRAM
      "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", // JUPITER_DCA_PROGRAM
      "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // PHOENIX_V1_PROGRAM
    ],
  });

  blockStreamer.on("transactions", (transactions: RPCTransaction[]) => {
    if (transactions.length === 0) return;
    console.log(transactions[0].slot, "TXs:", transactions.length);
  });

  await blockStreamer.start();
}

doWork();