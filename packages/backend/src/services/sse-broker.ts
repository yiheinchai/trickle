import { EventEmitter } from "events";
import { Response } from "express";

interface SseClient {
  res: Response;
  filter?: string;
}

class SseBroker extends EventEmitter {
  private clients: SseClient[] = [];

  addClient(res: Response, filter?: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // initial comment to establish connection

    const client: SseClient = { res, filter };
    this.clients.push(client);

    res.on("close", () => {
      this.removeClient(res);
    });
  }

  removeClient(res: Response): void {
    this.clients = this.clients.filter((c) => c.res !== res);
  }

  broadcast(event: string, data: unknown): void {
    const payload = JSON.stringify(data);
    const functionName =
      typeof data === "object" && data !== null && "functionName" in data
        ? (data as { functionName: string }).functionName
        : undefined;

    for (const client of this.clients) {
      if (client.filter && functionName) {
        if (!functionName.includes(client.filter)) {
          continue;
        }
      }
      client.res.write(`event: ${event}\ndata: ${payload}\n\n`);
    }
  }
}

export const sseBroker = new SseBroker();
