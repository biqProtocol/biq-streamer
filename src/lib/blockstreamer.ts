import { VersionedTransactionResponse } from "@solana/web3.js";
import EventEmitter from "events";
import WebSocket from "ws";
import { v4 as uuid } from "uuid";
import { 
  RPCBlock, 
  RPCMethodResultSlotUpdateNotification, 
  RPCResponse, 
  RPCTransaction 
} from "../types";
import dayjs from "dayjs";
import { delay } from "./delay";
import PQueue from "p-queue";

interface Logger {
  log: (message?: any, ...optionalParams: any[]) => void;
  warn: (message?: any, ...optionalParams: any[]) => void;
  error: (message?: any, ...optionalParams: any[]) => void;
}

export type SolanaBlockStreamerOptions = {
  /** Standard RPC connection for `getBlock` calls. */
  standardRPC?: string;
  /** Websocket only url, if not provided standardRPC will be used */
  websocketURL?: string;
  /** Interval in seconds to check if we received slots from websocket, defaults to 10s */
  slotsHealthCheckInterval?: number;
  /** Account addreses to subscribe to */
  accounts?: string[];
  /** Logger interface (defaults to console) */
  logger?: Logger;
  /** Number of slots to fetch before first received slot, defaults to 50 (should cover last 30s) */
  backFillSlots?: number;
  /** Fetch slots since this slot to the first received slot */
  backFillUntilSlot?: number;
  /** Number of parallel backfill tasks */
  backFillConcurrency?: number;
  /** Only process odd or even numbered slots (to split activity into 2 processes). TODO: refactor to split into more than 2 */
  streamFilterMode?: "odd" | "even";
}

export interface SolanaBlockStreamerEvents extends EventEmitter {
  on(event: "transactions", callback: (transaction: VersionedTransactionResponse[]) => void): this;
  on(event: "unfilteredTransactions", callback: (transaction: VersionedTransactionResponse[]) => void): this;
  on(event: "processedBlock", callback: (slot: number, blockTime: number) => void): this;
  on(event: "status", callback: (status: SolanaBlockStreamerStatus) => void): this;
}

export enum SolanaBlockStreamerStatus {
  DISCONNECTED = "DISCONNECTED",
  DISCONNECTING = "DISCONNECTING",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
}

const rpcHeaders = {
  "Content-Type": "application/json",
}

export class SolanaBlockStreamer extends EventEmitter implements SolanaBlockStreamerEvents {
  private standardURL: string;
  private websocketURL: string;
  private status: SolanaBlockStreamerStatus = SolanaBlockStreamerStatus.DISCONNECTED;
  private slotsWS: WebSocket | undefined;
  private slotMessages: number = 0;
  private slotsHealthCheckInterval: number = 10;
  private slotsHealthCheckTimer: NodeJS.Timeout | undefined;
  private accounts: string[] = null;
  private logger: Logger;
  private firstSlot: number;
  private backFillSlots: number = 50;
  private backFillUntilSlot: number;
  private backFillConcurrency: number = 5;
  private processedSlots: { slot: number, time: number }[] = [];
  private processedSlotsIndexed: Set<number> = new Set();
  private streamFilterMode: "odd" | "even" | undefined;

  constructor(options: SolanaBlockStreamerOptions) {
    super();

    if (typeof options.logger !== "undefined") {
      this.logger = options.logger;
    } else {
      this.logger = console;
    }

    if (typeof options.standardRPC === "undefined") throw new Error("Missing standard RPC");
    this.websocketURL = this.standardURL = options.standardRPC;

    if (typeof options.websocketURL !== "undefined") {
      this.websocketURL = options.websocketURL;
    }

    if (typeof options.accounts !== "undefined") {
      this.accounts = options.accounts;
    }

    if (typeof options.backFillSlots === "number") {
      this.backFillSlots = options.backFillSlots;
    }

    if (typeof options.backFillUntilSlot === "number") {
      this.backFillUntilSlot = options.backFillUntilSlot;
    }

    if (typeof options.backFillConcurrency === "number") {
      this.backFillConcurrency = options.backFillConcurrency;
    }

    if (typeof options.slotsHealthCheckInterval === "number") {
      this.slotsHealthCheckInterval = options.slotsHealthCheckInterval;
    }

    if (typeof options.streamFilterMode !== "undefined") {
      this.streamFilterMode = options.streamFilterMode;
    }

    setInterval(this.gcSlots.bind(this), 20000);
  }

  async start(backFillUntilSlot?: number) {
    if (this.status !== SolanaBlockStreamerStatus.DISCONNECTED) throw new Error("Not in disconected state");
    this.status = SolanaBlockStreamerStatus.CONNECTING;

    if (typeof backFillUntilSlot === "number") {
      this.backFillUntilSlot = backFillUntilSlot;
    }

    // connect to logs
    this.slotsConnect();

    // start health check timers
    this.slotsHealthCheckTimer = setInterval(async () => {
      if (this.slotMessages === 0) {
        this.logger.warn(`[STREAMER] [SLOTS] No messages received from RPC, reconnecting`);
        await this.stop();
        this.logger.warn(`[STREAMER] Disconnected`);
        this.start();
      } else {
        // this.logger.log(`[STREAMER] [ATLAS] ${this.atlasMessages} messages`);
        this.slotMessages = 0;
      }
    }, this.slotsHealthCheckInterval * 1000);
  }

  async stop() {
    if (this.status !== SolanaBlockStreamerStatus.CONNECTED) throw new Error("Not connected");

    this.status = SolanaBlockStreamerStatus.DISCONNECTING;

    clearInterval(this.slotsHealthCheckTimer);
    this.slotsHealthCheckTimer = undefined;

    this.slotsWS.close(1000);

    this.status = SolanaBlockStreamerStatus.DISCONNECTED;
  }

  private slotsConnect() {
    if (typeof this.slotsWS !== "undefined") {
      this.slotsWS.removeAllListeners();
    }
    this.slotsWS = new WebSocket(this.websocketURL || this.standardURL, {});
    this.slotsWS.on("open", this.slotsSubscribe.bind(this));
    this.slotsWS.on("message", this.slotsMessage.bind(this));
    this.slotsWS.on("error", this.slotsError.bind(this));
    this.slotsWS.on("close", this.slotsClose.bind(this));
  }

  private slotsSubscribe() {
    // subscribe to log events
    const requestId = uuid();
    const slotsSubscribeRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: "slotsUpdatesSubscribe",
    }
    if (this.slotsWS.readyState === WebSocket.OPEN) {
      this.slotsWS.send(JSON.stringify(slotsSubscribeRequest));
    } else {
      this.logger.error(`[STREAMER][slotsError] Slots WS not open [${this.slotsWS.readyState}]`);
    }
  }

  private async slotsMessage(data: WebSocket.Data) {
    const messageStr = data.toString('utf8');
    try {
      const message: RPCResponse<RPCMethodResultSlotUpdateNotification> = JSON.parse(messageStr);
      if (typeof message.result !== "undefined") {
        // subscription confirmation
        this.status = SolanaBlockStreamerStatus.CONNECTED;
        this.logger.log(`[STREAMER] [slotsMessage] Slots subscription confirmed`);
      } else if (typeof message.params !== "undefined") {
        this.slotMessages++;
        // slot update message
        const slotMessage = message.params.result;

        // try with optimisticConfirmation
        if (slotMessage.type === "optimisticConfirmation") {
          if (typeof this.streamFilterMode === "undefined"
            || (this.streamFilterMode === "odd" && slotMessage.slot % 2 === 1)
            || (this.streamFilterMode === "even" && slotMessage.slot % 2 === 0)
          ) {
            await this.fetchBlock(slotMessage.slot);
          } else {
            this.processedSlotsIndexed.add(slotMessage.slot);
            this.processedSlots.push({ slot: slotMessage.slot, time: dayjs().unix() });
          }
        } else if (slotMessage.type === "dead") {
          console.log(`[STREAMER] [slotsMessage] Dead slot ${slotMessage.slot} ${JSON.stringify(slotMessage.err)}`);
        }
      }
    } catch (error) {
      this.logger.error(`[STREAMER] [slotsMessage] ${messageStr}`);
      this.logger.error(error);
    }
  }

  private slotsError(error: Error) {
    // what errors could we receive ???
    this.logger.log(`[STREAMER] [slotsError]`, error);
  }

  private slotsClose(code: number, reason: string) {
    // check to see if we need to reconnect
    this.logger.log(`[STREAMER] Slots CLOSE ${code}: ${reason}`);
    if (code !== 1000) {
      this.slotsConnect();
    }
  }

  private purgeSlots() {
    if (this.processedSlots.length > 0) {
      // Remove slots older than 10 minutes (we do this to account for backfill)
      const olderThan = dayjs().subtract(10, "minute").unix();
      let removeFirst = 0;
      do {
        if (this.processedSlots[removeFirst].time < olderThan) {
          removeFirst++;
        } else {
          break;
        }
      } while (removeFirst < this.processedSlots.length);
      if (removeFirst > 0) {
        // console.log(`[STREAMER] [GC] Removing ${removeFirst} slots`);
        const removedSlots = this.processedSlots.splice(0, removeFirst);
        removedSlots.forEach((slot) => this.processedSlotsIndexed.delete(slot.slot));
      }
    }
  }

  private gcSlots_Lock: boolean = false;
  private async gcSlots() {
    if (this.status === SolanaBlockStreamerStatus.CONNECTED && this.processedSlots.length > 0) {
      if (this.gcSlots_Lock === false) {
        this.gcSlots_Lock = true;

        // Sort by slot asc
        this.processedSlots.sort((a, b) => a.slot - b.slot);

        this.purgeSlots();

        // check missing slots
        const missingSlots: number[] = [];
        // check only slots older than 5 seconds only as newer might still be fetching
        const timeLimit = dayjs().subtract(5, "seconds").unix();
        for (let i = 0; i < this.processedSlots.length - 1; i++) {
          if (this.processedSlots[i].time > timeLimit) {
            break;
          }
          if (this.processedSlots[i].slot + 1 !== this.processedSlots[i + 1].slot) {
            // fetch missing slots
            for (let j = this.processedSlots[i].slot + 1; j < this.processedSlots[i + 1].slot; j++) {
              missingSlots.push(j);
            }
          }
        }

        if (missingSlots.length > 0) {
          console.log(`[STREAMER] [GC] Fetching missing slots ${JSON.stringify(missingSlots)}`);
          const failedSlots: number[] = [];
          for (const slot of missingSlots) {
            let queue = new PQueue({
              concurrency: this.backFillConcurrency,
              autoStart: true,
            });
            queue.add(async () => {
              const success = await this.fetchBlock(slot);
              if (success === false) {
                failedSlots.push(slot);
                this.processedSlots.push({ slot, time: dayjs().unix() });
                this.processedSlotsIndexed.add(slot);
              }
            });
            do {
              await delay(2000);
              this.purgeSlots();
            } while (queue.size + queue.pending > 0);
          }
          if (failedSlots.length > 0) {
            console.log(`[STREAMER] [GC] Failed to fetch slots ${JSON.stringify(failedSlots)}`);
          }
        }

        this.gcSlots_Lock = false;
      }
    }
  }

  private fetchBlock_Lock: Set<number> = new Set();
  private async fetchBlock(slot: number): Promise<boolean> {
    // fetch block from standard RPC
    if (!this.processedSlotsIndexed.has(slot) && !this.fetchBlock_Lock.has(slot)) {
      this.fetchBlock_Lock.add(slot);

      const request = {
        jsonrpc: "2.0",
        id: `bl${slot}`,
        method: "getBlock",
        params: [
          slot,
          {
            commitment: "confirmed",
            encoding: "json",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 0,
            rewards: false,
          }
        ]
      }

      let retry = 3;
      let errors: string[] = [];
      do {
        try {
          const response = await fetch(this.standardURL, {
            method: "POST",
            headers: Object.assign({
              "Content-Type": "application/json"
            }, rpcHeaders),
            body: JSON.stringify(request)
          });

          if (response.ok) {
            const body = await response.json() as any;
            if (typeof body.result !== "undefined" && body.result !== null && typeof body.result.blockhash !== "undefined") {
              this.processedSlotsIndexed.add(slot);
              this.processedSlots.push({ slot, time: body.result.blockTime || dayjs().unix() });
              this.processBlock(slot, body.result as RPCBlock);
              // backfill slots, only happens once
              if (typeof this.firstSlot === "undefined") {
                this.firstSlot = slot;
                this.fetchBackFillSlots();
              }
              this.fetchBlock_Lock.delete(slot);
              return true;
            }
          } else {
            errors.push(`Response error ${response.status}`);
          }
        } catch (error) {
          errors.push(JSON.stringify(error));
        }
        await delay(300);
      } while (retry-- > 0);
      if (errors.length > 0) {
        this.logger.error(`[STREAMER] [fetchBlock] Slot: ${slot}, Errors: `, errors);
      }
      this.fetchBlock_Lock.delete(slot);
    }
    return false;
  }

  async fetchBackFillSlots(slots?: number[]) {
    // wait for gc to finish and lock it
    while (this.gcSlots_Lock === true) {
      await delay(100);
    }
    this.gcSlots_Lock = true;
    let queue = new PQueue({
      concurrency: this.backFillConcurrency,
      autoStart: true,
    });
    if (typeof slots !== "undefined" && slots.length > 0) {
      console.log(`[STREAMER] [fetchBackFillSlots] Fetching ${slots.length} requested slots ${JSON.stringify(slots)}`);
      for (const slot of slots) {
        queue.add(async () => { await this.fetchBlock(slot) });
      }
    } else if (typeof this.backFillUntilSlot !== "undefined") {
      if (this.firstSlot - this.backFillUntilSlot - 1 > 50) {
        console.warn(`[STREAMER] [fetchBackFillSlots] Too many slots to backfill so skipping, from ${this.backFillUntilSlot + 1} to ${this.firstSlot - 1} (${this.firstSlot - this.backFillUntilSlot - 1} slots)`);
      } else {
        console.log(`[STREAMER] [fetchBackFillSlots] Fetching slots from ${this.backFillUntilSlot + 1} to ${this.firstSlot - 1} (${this.firstSlot - this.backFillUntilSlot - 1} slots)`);
        // it is possible this can take a long while, we should fetch in parallel
        for (let slot = this.backFillUntilSlot + 1; slot < this.firstSlot; slot++) {
          queue.add(async () => { await this.fetchBlock(slot) });
        }
      }
    } else {
      console.log(`[STREAMER] [fetchBackFillSlots] Fetching ${this.backFillSlots} slots until ${this.firstSlot - 1}`);
      for (let i = 1; i <= this.backFillSlots; i++) {
        queue.add(async () => { await this.fetchBlock(this.firstSlot - i) });
      }
    }
    do {
      await delay(5000);
      // remove from processedSlots
      this.purgeSlots();
      console.log(`[STREAMER] [fetchBackFillSlots] Queue size:${queue.size} pending:${queue.pending}`);
    } while (queue.size + queue.pending > 0);
    console.log(`[STREAMER] [fetchBackFillSlots] Done fetching backfill slots`);
    this.gcSlots_Lock = false;
  }

  processBlock(slot: number, block: RPCBlock) {
    this.emit("processedBlock", slot, block.blockTime);
    // remove transactions with errors and votes
    block.transactions = block.transactions.filter((tx: any) => (tx.err === null || typeof tx.err === "undefined") && tx.meta?.logMessages[0] !== "Program Vote111111111111111111111111111111111111111 invoke [1]");

    // add slot and blockTime to transactions
    block.transactions.forEach((tx: any) => {
      tx.slot = slot;
      tx.blockTime = block.blockTime;
    });

    // if accounts is set, we only need to emit transactions that match those accounts
    // the rest are emited as unfiltered
    if (this.accounts !== null) {
      const transactions: RPCTransaction[] = [];
      const unfilteredTransactions: RPCTransaction[] = [];
      for (const tx of block.transactions) {
        const indexedAccounts = new Set<string>();
        if (Array.isArray(tx.transaction?.message?.accountKeys)) {
          tx.transaction.message.accountKeys.forEach((account: string) => indexedAccounts.add(account));
        }
        if (typeof tx.meta?.loadedAddresses !== "undefined") {
          if (typeof tx.meta.loadedAddresses.writable !== "undefined") {
            tx.meta.loadedAddresses.writable.forEach((account: string) => indexedAccounts.add(account));
          }
          if (typeof tx.meta.loadedAddresses.readonly !== "undefined") {
            tx.meta.loadedAddresses.readonly.forEach((account: string) => indexedAccounts.add(account));
          }
        }
        // TODO: when we will switch to node 22.0 we can perform Set.intersection()
        let emited = false;
        for (const account of this.accounts) {
          if (indexedAccounts.has(account)) {
            emited = true;
            transactions.push(tx);
            break;
          }
        }
        if (emited === false) {
          unfilteredTransactions.push(tx);
        }
      }
      if (transactions.length > 0) {
        this.emit("transactions", transactions);
      }
      if (unfilteredTransactions.length > 0) {
        this.emit("unfilteredTransactions", unfilteredTransactions);
      }
    } else {
      this.emit("transactions", block.transactions);
    }
  }
}