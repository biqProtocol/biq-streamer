import {
  CompiledInnerInstruction,
  CompiledInstruction,
  MessageHeader,
  TokenBalance,
  TransactionError,
  TransactionVersion
} from "@solana/web3.js";

export type RPCResponse<T> = {
  jsonrpc: "2.0";
  method: "transactionNotification";
  params?: {
    subscription: number | string;
    result: T;
  };
  result?: number | string;
  id?: number | string;
}

export type RPCTransaction = {
  transaction: {
    signatures: string[];
    message: MessageResponse;
  };
  meta?: MetaResponse;
  version: TransactionVersion;
  // Never actually present in notification
  blockTime?: null | number;
  // Never actually present in notification
  slot?: null | number;
}

export type RPCBlock = {
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  transactions: RPCTransaction[];
  blockTime: number | null;
  blockHeight: number;
}

export type RPCMethodResultSlotUpdateNotification = {
  err?: string;
  parent: number;
  slot: number;
  stats?: {
    maxTransactionsPerEntry: number;
    numFailedTransactions: number;
    numSuccessfulTransactions: number;
    numTransactionEntries: number;
  };
  timestamp: number;
  type: "firstShredReceived" | "completed" | "createdBank" | "frozen" | "dead" | "optimisticConfirmation" | "root";
}

/**
 * A processed transaction message from the RPC API
 */
export type MessageResponse = {
  accountKeys: string[];
  header: MessageHeader;
  instructions: CompiledInstruction[];
  recentBlockhash: string;
  addressTableLookups?: AddressTableLookupResponse[];
};

export type AddressTableLookupResponse = {
  /** Address lookup table account key */
  accountKey: string;
  /** Parsed instruction info */
  writableIndexes: number[];
  /** Parsed instruction info */
  readonlyIndexes: number[];
};

/**
 * Metadata for a confirmed transaction on the ledger
 */
export type MetaResponse = {
  /** The fee charged for processing the transaction */
  fee: number;
  /** An array of cross program invoked instructions */
  innerInstructions?: CompiledInnerInstruction[] | null;
  /** The balances of the transaction accounts before processing */
  preBalances: Array<number>;
  /** The balances of the transaction accounts after processing */
  postBalances: Array<number>;
  /** An array of program log messages emitted during a transaction */
  logMessages?: Array<string> | null;
  /** The token balances of the transaction accounts before processing */
  preTokenBalances?: Array<TokenBalance> | null;
  /** The token balances of the transaction accounts after processing */
  postTokenBalances?: Array<TokenBalance> | null;
  /** The error result of transaction processing */
  err: TransactionError | null;
  /** The collection of addresses loaded using address lookup tables */
  loadedAddresses?: LoadedAddressesResponse;
  /** The compute units consumed after processing the transaction */
  computeUnitsConsumed?: number;
};

/**
 * Collection of addresses loaded by a transaction using address table lookups
 */
export type LoadedAddressesResponse = {
  writable: Array<string>;
  readonly: Array<string>;
};
