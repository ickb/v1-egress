import {
  TransactionSkeleton,
  encodeToAddress,
  sealTransaction,
  type TransactionSkeletonType,
} from "@ckb-lumos/helpers";
import { prepareSigningEntries } from "@ckb-lumos/common-scripts/lib/secp256k1_blake160.js";
import { key } from "@ckb-lumos/hd";
import {
  CKB,
  I8Cell,
  I8Header,
  I8Script,
  addCells,
  addCkbChange,
  addWitnessPlaceholder,
  binarySearch,
  calculateTxFee,
  capacitySifter,
  chainConfigFrom,
  ckbDelta,
  isChain,
  isDaoWithdrawalRequest,
  isPopulated,
  lockExpanderFrom,
  maturityDiscriminator,
  max,
  shuffle,
  since,
  txSize,
  type ChainConfig,
  type ConfigAdapter,
} from "@ickb/lumos-utils";
import {
  addOwnedWithdrawalRequestsChange,
  addReceiptDepositsChange,
  addWithdrawalRequestGroups,
  ckb2Ickb,
  ckbSoftCapPerDeposit,
  getIckbScriptConfigs,
  ickb2Ckb,
  ickbDelta,
  ickbExchangeRatio,
  ickbLogicScript,
  ickbPoolSifter,
  ickbRequestWithdrawalFrom,
  ickbSifter,
  limitOrderScript,
  orderMelt,
  orderMint,
  orderSifter,
  ownedOwnerScript,
  type ExtendedDeposit,
  type MyOrder,
} from "@ickb/v1-core";

async function main() {
  const { CHAIN, RPC_URL, EGRESS_PRIVATE_KEY, EGRESS_SLEEP_INTERVAL } =
    process.env;
  if (!isChain(CHAIN)) {
    throw Error("Invalid env CHAIN: " + CHAIN);
  }
  if (!EGRESS_PRIVATE_KEY) {
    throw Error("Empty env EGRESS_PRIVATE_KEY");
  }
  if (!EGRESS_SLEEP_INTERVAL || Number(EGRESS_SLEEP_INTERVAL) < 1) {
    throw Error("Invalid env EGRESS_SLEEP_INTERVAL");
  }

  const chainConfig = await chainConfigFrom(
    CHAIN,
    RPC_URL,
    true,
    getIckbScriptConfigs,
  );
  const { config, rpc } = chainConfig;
  const account = secp256k1Blake160(EGRESS_PRIVATE_KEY, config);
  const sleepInterval = Number(EGRESS_SLEEP_INTERVAL) * 1000;

  while (true) {
    await new Promise((r) => setTimeout(r, sleepInterval));
    console.log();

    let executionLog: any = {};
    let startTime = new Date();
    executionLog.startTime = startTime.toLocaleString();
    try {
      const {
        capacities,
        udts,
        receipts,
        matureWrGroups,
        notMatureWrGroups,
        ickbPool,
        myOrders,
        tipHeader,
        feeRate,
      } = await getL1State(account, chainConfig);

      // Calculate balances and baseTx
      const baseTx = base({
        capacities,
        myOrders,
        udts,
        receipts,
        wrGroups: matureWrGroups,
      });
      const availableCkbBalance = ckbDelta(baseTx, config);
      const ickbUdtBalance = ickbDelta(baseTx, config);
      const unavailableFunds = base({
        wrGroups: notMatureWrGroups,
      });
      const unavailableCkbBalance = ckbDelta(unavailableFunds, config);
      const ckbBalance = availableCkbBalance + unavailableCkbBalance;

      executionLog.balance = {
        CKB: {
          total: fmtCkb(ckbBalance),
          available: fmtCkb(availableCkbBalance),
          unavailable: fmtCkb(unavailableCkbBalance),
        },
        ICKB: {
          total: fmtCkb(ickbUdtBalance),
          available: fmtCkb(ickbUdtBalance),
          unavailable: fmtCkb(0n),
        },
        totalEquivalent: {
          CKB: fmtCkb(ckbBalance + ickb2Ckb(ickbUdtBalance, tipHeader)),
          ICKB: fmtCkb(ckb2Ickb(ckbBalance, tipHeader) + ickbUdtBalance),
        },
      };
      executionLog.ratio = ickbExchangeRatio(tipHeader);

      // console.log(JSON.stringify(executionLog, replacer, " "));

      if (
        ickbUdtBalance === 0n &&
        myOrders.length === 0 &&
        matureWrGroups.length === 0 &&
        notMatureWrGroups.length === 0
      ) {
        executionLog.error =
          "All iCKB UDT already converted back to CKB, nothing to do, shutting down...";
        console.log(JSON.stringify(executionLog, replacer, " "));
        return;
      }

      let tx = convert(
        baseTx,
        false,
        ickbUdtBalance,
        ckbSoftCapPerDeposit(tipHeader),
        ickbPool,
        tipHeader,
        feeRate,
        account,
        chainConfig,
      );

      if (isPopulated(tx)) {
        const withdrawalRequests = tx.outputs.filter((c) =>
          isDaoWithdrawalRequest(c, config),
        ).size;
        const withdrawals = tx.inputs.filter((c) =>
          isDaoWithdrawalRequest(c, config),
        ).size;

        executionLog.actions = {
          withdrawalRequests,
          withdrawals,
        };
        executionLog.txFee = {
          fee: fmtCkb(ckbDelta(tx, config)),
          feeRate,
        };

        if (withdrawalRequests > 0 || tx.inputs > tx.outputs) {
          executionLog.txHash = await rpc.sendTransaction(account.signer(tx));
        } else {
          continue;
        }
      } else {
        continue;
      }
    } catch (e: any) {
      if (e) {
        executionLog.error = { ...e, stack: e.stack ?? "" };
      } else {
        executionLog.message = "Empty";
      }
    }
    executionLog.ElapsedSeconds = Math.round(
      (new Date().getTime() - startTime.getTime()) / 1000,
    );
    console.log(JSON.stringify(executionLog, replacer, " ") + ",");
  }
}

function fmtCkb(b: bigint) {
  return Number(b) / Number(CKB);
}

function replacer(_: unknown, value: unknown) {
  return typeof value === "bigint" ? Number(value) : value;
}

type MyExtendedDeposit = ExtendedDeposit & { ickbCumulative: bigint };

function convert(
  baseTx: TransactionSkeletonType,
  isCkb2Udt: boolean,
  maxAmount: bigint,
  depositAmount: bigint,
  deposits: Readonly<ExtendedDeposit[]>,
  tipHeader: Readonly<I8Header>,
  feeRate: bigint,
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const ickbPool: MyExtendedDeposit[] = [];
  if (!isCkb2Udt) {
    // Filter deposits
    let ickbCumulative = 0n;
    for (const d of deposits) {
      const c = ickbCumulative + d.ickbValue;
      if (c > maxAmount) {
        continue;
      }
      ickbCumulative = c;
      ickbPool.push(Object.freeze({ ...d, ickbCumulative }));
      if (ickbPool.length >= 30) {
        break;
      }
    }
  }
  Object.freeze(ickbPool);

  const N = isCkb2Udt ? Number(maxAmount / depositAmount) : ickbPool.length;
  const txCache = Array<TransactionSkeletonType | undefined>(N);
  const attempt = (n: number) => {
    n = N - n;
    return (txCache[n] =
      txCache[n] ??
      convertAttempt(
        n,
        isCkb2Udt,
        maxAmount,
        baseTx,
        ickbPool,
        tipHeader,
        feeRate,
        account,
        chainConfig,
      ));
  };
  return attempt(binarySearch(N, (n) => isPopulated(attempt(n))));
}

function convertAttempt(
  quantity: number,
  isCkb2Udt: boolean,
  maxAmount: bigint,
  tx: TransactionSkeletonType,
  ickbPool: Readonly<MyExtendedDeposit[]>,
  tipHeader: Readonly<I8Header>,
  feeRate: bigint,
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { config } = chainConfig;
  if (quantity > 0) {
    if (isCkb2Udt) {
      // Do not create new deposits
      return TransactionSkeleton();
    } else {
      if (ickbPool.length < quantity) {
        return TransactionSkeleton();
      }
      maxAmount -= ickbPool[quantity - 1].ickbCumulative;
      if (maxAmount < 0n) {
        return TransactionSkeleton();
      }
      const deposits = ickbPool.slice(0, quantity).map((d) => d.deposit);
      tx = ickbRequestWithdrawalFrom(tx, deposits, config);
    }
  }

  tx = addChange(tx, feeRate, account, tipHeader, chainConfig);

  if (quantity > 0 && tx.outputs.size > 64) {
    return TransactionSkeleton();
  }

  return tx;
}

function addChange(
  tx: TransactionSkeletonType,
  feeRate: bigint,
  account: ReturnType<typeof secp256k1Blake160>,
  tipHeader: I8Header,
  chainConfig: ChainConfig,
) {
  const { lockScript: accountLock, preSigner: addPlaceholders } = account;
  const { config } = chainConfig;

  // Add as usual receipts and owner cells
  tx = addReceiptDepositsChange(tx, accountLock, config);
  tx = addOwnedWithdrawalRequestsChange(tx, accountLock, config);

  // Add UDT change cell as and iCKB to CKB limit order
  let freeIckb = ickbDelta(tx, config);
  if (freeIckb > 0) {
    tx = orderMint(
      tx,
      accountLock,
      config,
      undefined,
      freeIckb,
      undefined,
      ickbExchangeRatio(tipHeader),
    );
  } else if (freeIckb < 0n) {
    return TransactionSkeleton();
  }

  let freeCkb;
  ({ tx, freeCkb } = addCkbChange(
    tx,
    accountLock,
    (txWithDummyChange: TransactionSkeletonType) => {
      const baseFee = calculateTxFee(
        txSize(addPlaceholders(txWithDummyChange)),
        feeRate,
      );
      // Use a fee that is multiple of N=1249
      const N = 1249n;
      return ((baseFee + (N - 1n)) / N) * N;
    },
    config,
  ));

  if (freeCkb < 0n) {
    return TransactionSkeleton();
  }

  return tx;
}

function base({
  capacities = [],
  udts = [],
  receipts = [],
  wrGroups = [],
  myOrders = [],
}: {
  capacities?: I8Cell[];
  udts?: I8Cell[];
  receipts?: I8Cell[];
  wrGroups?: Readonly<{
    ownedWithdrawalRequest: I8Cell;
    owner: I8Cell;
  }>[];
  myOrders?: MyOrder[];
}) {
  let tx = TransactionSkeleton();
  tx = addCells(tx, "append", [capacities, udts, receipts].flat(), []);
  tx = addWithdrawalRequestGroups(tx, wrGroups);
  tx = orderMelt(tx, myOrders);
  return tx;
}

async function getL1State(
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { config, rpc } = chainConfig;
  const { expander } = account;

  const mixedCells = await getMixedCells(account, chainConfig);

  // Prefetch feeRate and tipHeader
  const feeRatePromise = rpc.getFeeRate(61n);
  const tipHeaderPromise = rpc.getTipHeader();

  // Prefetch headers
  const wanted = new Set<string>();
  const deferredGetHeader = (blockNumber: string) => {
    wanted.add(blockNumber);
    return headerPlaceholder;
  };
  const { notIckbs } = ickbSifter(
    mixedCells,
    expander,
    deferredGetHeader,
    config,
  );
  const headersPromise = getHeadersByNumber(wanted, chainConfig);

  // Do potentially costly operations
  const { capacities, notCapacities } = capacitySifter(notIckbs, expander);
  const { myOrders } = orderSifter(notCapacities, expander, config);

  // Await for headers
  const headers = await headersPromise;

  // Sift through iCKB related cells
  const {
    udts,
    receipts,
    withdrawalRequestGroups,
    ickbPool: pool,
  } = ickbSifter(
    mixedCells,
    expander,
    (blockNumber) => headers.get(blockNumber)!,
    config,
  );

  const tipHeader = I8Header.from(await tipHeaderPromise);
  // Partition between ripe and non ripe withdrawal requests
  const { mature: matureWrGroups, notMature: notMatureWrGroups } =
    maturityDiscriminator(
      withdrawalRequestGroups,
      (g) => g.ownedWithdrawalRequest.cellOutput.type![since],
      tipHeader,
    );

  // min lock: 1/4 epoch (~ 1 hour)
  const minLock = { length: 4, index: 1, number: 0 };
  // Sort the ickbPool based on the tip header
  let ickbPool = ickbPoolSifter(pool, tipHeader, minLock);
  // Take a random convenient subset of max 40 deposits
  if (ickbPool.length > 40) {
    const n = max(Math.round(ickbPool.length / 180), 40);
    ickbPool = shuffle(ickbPool.slice(0, n).map((d, i) => ({ d, i })))
      .slice(0, 40)
      .sort((a, b) => a.i - b.i)
      .map((a) => a.d);
  }

  return {
    capacities,
    udts,
    receipts,
    matureWrGroups,
    notMatureWrGroups,
    myOrders,
    ickbPool,
    tipHeader,
    feeRate: max(await feeRatePromise, 1000n),
  };
}

async function getMixedCells(
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { rpc, config } = chainConfig;
  return (
    await Promise.all(
      [
        account.lockScript,
        ickbLogicScript(config),
        ownedOwnerScript(config),
        limitOrderScript(config),
      ].map((lock) => rpc.getCellsByLock(lock, "desc", "max")),
    )
  ).flat();
}

async function getHeadersByNumber(
  wanted: Set<string>,
  chainConfig: ChainConfig,
) {
  const { rpc } = chainConfig;

  const result = new Map<string, Readonly<I8Header>>();
  const batch = rpc.createBatchRequest();
  for (const blockNum of wanted) {
    const h = _knownHeaders.get(blockNum);
    if (h !== undefined) {
      result.set(blockNum, h);
      continue;
    }
    batch.add("getHeaderByNumber", blockNum);
  }

  if (batch.length === 0) {
    return _knownHeaders;
  }

  for (const h of await batch.exec()) {
    result.set(h.number, I8Header.from(h));
  }

  const frozenResult = Object.freeze(result);
  _knownHeaders = frozenResult;
  return frozenResult;
}

let _knownHeaders = Object.freeze(new Map<string, Readonly<I8Header>>());

const headerPlaceholder = I8Header.from({
  compactTarget: "0x1a08a97e",
  parentHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  transactionsRoot:
    "0x31bf3fdf4bc16d6ea195dbae808e2b9a8eca6941d589f6959b1d070d51ac28f7",
  proposalsHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  extraHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  dao: "0x8874337e541ea12e0000c16ff286230029bfa3320800000000710b00c0fefe06",
  epoch: "0x0",
  hash: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
  nonce: "0x0",
  number: "0x0",
  timestamp: "0x16e70e6985c",
  version: "0x0",
});

function secp256k1Blake160(privateKey: string, config: ConfigAdapter) {
  const publicKey = key.privateToPublic(privateKey);

  const lockScript = I8Script.from({
    ...config.defaultScript("SECP256K1_BLAKE160"),
    args: key.publicKeyToBlake160(publicKey),
  });

  const address = encodeToAddress(lockScript, { config });

  const expander = lockExpanderFrom(lockScript);

  function preSigner(tx: TransactionSkeletonType) {
    return addWitnessPlaceholder(tx, lockScript);
  }

  function signer(tx: TransactionSkeletonType) {
    tx = preSigner(tx);
    tx = prepareSigningEntries(tx, { config });
    const message = tx.get("signingEntries").get(0)!.message; //How to improve in case of multiple locks?
    const sig = key.signRecoverable(message!, privateKey);

    return sealTransaction(tx, [sig]);
  }

  return {
    publicKey,
    lockScript,
    address,
    expander,
    preSigner,
    signer,
  };
}

main();
