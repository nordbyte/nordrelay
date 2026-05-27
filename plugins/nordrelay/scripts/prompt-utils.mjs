import readline from "node:readline/promises";

export async function ask(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  if (rl) {
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    prompt.close();
  }
}

export async function askSecret(rl, label, defaultValue) {
  void rl;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const suffix = defaultValue ? " [hidden default]" : "";
  return await new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let value = "";
    output.write(`${label}${suffix}: `);
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value || defaultValue);
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += char;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
}

export async function askChoice(rl, label, defaultValue) {
  const value = (await ask(rl, label, defaultValue)).toLowerCase();
  if (["1", "yes", "y", "true", "on"].includes(value)) return "true";
  if (["0", "no", "n", "false", "off"].includes(value)) return "false";
  return value || defaultValue;
}
