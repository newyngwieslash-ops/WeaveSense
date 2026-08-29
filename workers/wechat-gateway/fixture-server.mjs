import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function createFixtureServer(fixture) {
  return createServer((req, res) => {
    if (req.url !== "/primary.atom") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
    res.end(fixture);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await readFile(new URL("./fixtures/primary.atom", import.meta.url));
  createFixtureServer(fixture).listen(8791, "0.0.0.0");
}
