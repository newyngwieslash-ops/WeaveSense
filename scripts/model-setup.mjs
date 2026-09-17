import { copyFileSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";
mkdirSync("config", { recursive: true });
try {
  copyFileSync("config/model.example.json", "config/model.local.json", constants.COPYFILE_EXCL);
  console.log("已创建配置文件，请自行填写 apiKey 和 model：", resolve("config/model.local.json"));
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("配置文件已存在，保留原内容：", resolve("config/model.local.json"));
}
