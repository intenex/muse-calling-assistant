import fs from "node:fs";
export function readLocalEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(".dev.vars", "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i),
          l
            .slice(i + 1)
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        ];
      }),
  );
}
