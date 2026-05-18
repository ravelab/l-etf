import { simulateFuturesSmaStrategy, type FuturesStrategyParams } from "./futures";

type FuturesWorkerRequest = {
  id: number;
  params: FuturesStrategyParams;
};

self.onmessage = (event: MessageEvent<FuturesWorkerRequest>) => {
  try {
    const result = simulateFuturesSmaStrategy(event.data.params);
    self.postMessage({ id: event.data.id, type: "result", result });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      type: "error",
      message: error instanceof Error ? error.message : "Futures worker failed",
    });
  }
};
