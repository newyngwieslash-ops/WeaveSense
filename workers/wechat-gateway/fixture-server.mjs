import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const fixture = await readFile(new URL("./fixtures/primary.atom", import.meta.url));

createServer((req, res) => {
  if (req.url !== "/primary.atom") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
  res.end(fixture);
}).listen(8791, "0.0.0.0");
