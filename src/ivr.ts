import { z } from "zod";
import { ApiError, type CallBrief } from "./domain";

export const KeypadSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    menuId: z.string().uuid(),
    digits: z.string().regex(/^[0-9*#]{1,24}$/),
    factId: z.string().max(80).optional(),
  })
  .strict();
export type IvrOption = { digits: string; label: string };
export type IvrMenu = {
  id: string;
  mode?: "auto" | "assisted";
  prompt: string;
  options: IvrOption[];
  kind: "menu" | "input";
  revision: number;
  observedAt: number;
  expiresAt: number;
  status: "pending" | "sending" | "sent" | "uncertain" | "failed" | "expired";
  operationId?: string;
  digitCount?: number;
};
export function normalizeIvr(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}*#]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
const names: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  star: "*",
  asterisk: "*",
  pound: "#",
  hash: "#",
};
const digit =
  "(?:[0-9*#]+|zero|one|two|three|four|five|six|seven|eight|nine|star|asterisk|pound|hash)";
// Parse offered keys, never infer a key from a department name alone.
export function parseIvr(
  prompt: string,
): Pick<IvrMenu, "kind" | "options"> | undefined {
  if (
    /\b(?:press|enter)\s+any\s+(?:key|digit|number)\b/i.test(prompt) &&
    !consequentialOption(prompt)
  ) {
    return {
      kind: "menu",
      options: Array.from({ length: 10 }, (_, n) => ({
        digits: String(n),
        label: "Any numeric key: " + prompt.slice(-300),
      })),
    };
  }
  const options: IvrOption[] = [];
  const re = new RegExp(
    `\\b(?:press|dial|select|choose|push)\\s+(?:the\\s+)?(${digit})(?=\\s|[.,;!?]|$)`,
    "gi",
  );
  const matches = [...prompt.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i],
      start = m.index!,
      end = start + m[0].length;
    const before = prompt.slice(
      i ? matches[i - 1].index! + matches[i - 1][0].length : 0,
      start,
    );
    const after = prompt.slice(end, matches[i + 1]?.index ?? prompt.length);
    const preceding = before.match(/\bfor\s+([^.!?;]+?)[,\s]*(?:please\s+)?$/i);
    const following = after.match(/^\s*(?:for|to)\s+([^.!?;]+)/i);
    let label = (
      preceding?.[1] ??
      following?.[1] ??
      before.split(/[.!?;]/).at(-1) ??
      ""
    )
      .trim()
      .replace(/[,\s]+$/g, "");
    label = label.replace(/\s*(?:please\s*)?$/i, "").slice(-350);
    const digits = names[m[1].toLowerCase()] ?? m[1];
    if (digits.length <= 4 && label.length > 1) options.push({ digits, label });
  }
  if (
    /\b(?:enter|key in|type)\b/i.test(prompt) &&
    /\b(?:account|reference|confirmation|extension|number|pin|code|date of birth|zip|postal)\b/i.test(
      prompt,
    ) &&
    !/\bfor\b[^.!?;]+\bpress\b|\bpress\b[^.!?;]+\bfor\b/i.test(prompt)
  )
    return { kind: "input", options: [] };
  if (options.length) {
    const unique = options.filter(
      (o, i) =>
        options.findIndex(
          (x) =>
            x.digits === o.digits &&
            normalizeIvr(x.label) === normalizeIvr(o.label),
        ) === i,
    );
    return { kind: "menu", options: unique.slice(-12) };
  }
  if (
    /\b(?:enter|key in|type|dial)\b/i.test(prompt) &&
    /\b(?:account|reference|confirmation|extension|number|pin|code|date of birth|zip|postal)\b/i.test(
      prompt,
    )
  )
    return { kind: "input", options: [] };
}
// Navigation to a payments/cancellation department is not itself acceptance.
export function consequentialOption(label: string) {
  return /\b(?:confirm|authorize|accept|agree|purchase|subscribe|donate|pay now|make (?:a |the )?payment|cancel (?:your |the |this )?(?:account|booking|reservation|appointment|membership)|delete|transfer (?:money|funds))\b/i.test(
    label,
  );
}
export function validateKeypad(
  menu: IvrMenu,
  digits: string,
  brief: CallBrief,
  factId?: string,
) {
  if (!/^[0-9*#]{1,24}$/.test(digits))
    throw new ApiError(
      422,
      "invalid_digits",
      "Use at most 24 keypad digits (0-9, * or #)",
    );
  if (menu.kind === "menu") {
    const choices = menu.options.filter((o) => o.digits === digits);
    if (!choices.length)
      throw new ApiError(
        422,
        "unoffered_digits",
        "The current menu did not offer these digits",
      );
    if (choices.some((o) => consequentialOption(o.label)))
      throw new ApiError(
        403,
        "keypad_commitment_blocked",
        "This option may make a commitment; request a representative instead",
      );
  } else {
    const fact = brief.facts.find(
      (f) => f.id === factId && f.visibility === "shareable",
    );
    // Supply an explicitly shareable numeric fact, not arbitrary numbers/private context.
    const value = fact?.text.trim();
    if (
      !value ||
      !/^[\d\s()+.\/-]+$/.test(value) ||
      value.replace(/\D/g, "") !== digits.replace(/#$/, "")
    )
      throw new ApiError(
        403,
        "keypad_fact_required",
        "Data entry requires a shareable numeric fact matching the entered digits exactly",
      );
    if (digits.endsWith("#") && !/\b(?:pound|hash)\b|#/i.test(menu.prompt))
      throw new ApiError(
        422,
        "unrequested_terminator",
        "The prompt did not request a pound/hash terminator",
      );
  }
}
export function selectIvrOption(
  menu: IvrMenu,
  brief: CallBrief,
): string | undefined {
  if (menu.kind !== "menu") return;
  const goal = normalizeIvr(brief.ivr?.goal ?? brief.objective);
  const language = normalizeIvr(brief.language);
  const wanted = new Set(
    goal
      .split(" ")
      .filter(
        (w) =>
          w.length > 3 &&
          ![
            "call",
            "please",
            "would",
            "about",
            "with",
            "that",
            "this",
            "have",
            "want",
          ].includes(w),
      ),
  );
  const scored = menu.options
    .filter((o) => !consequentialOption(o.label))
    .map((o) => {
      const label = normalizeIvr(o.label);
      let score =
        3 *
        [...wanted].filter((w) => new RegExp(`\\b${w}\\b`).test(label)).length;
      if (label.includes(language)) score += 5;
      if (
        /\b(?:representative|operator|agent|other inquiries|all other)\b/.test(
          label,
        ) &&
        !/\b(?:automated|balance inquiry)\b/.test(goal)
      )
        score += 2;
      return { ...o, score };
    })
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0 && (!scored[1] || scored[0].score > scored[1].score))
    return scored[0].digits;
}
