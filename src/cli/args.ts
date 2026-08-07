import { z } from "zod";
import type { ActionDef } from "../core/actions.js";

/**
 * Maps a shell-style argv onto the same zod schema the MCP front-end uses, so
 * `agentbrowser click e12 --double` and the MCP `click` tool validate identically.
 */

function baseType(type: z.ZodTypeAny): z.ZodTypeAny {
  if (type instanceof z.ZodOptional || type instanceof z.ZodNullable) return baseType(type.unwrap());
  if (type instanceof z.ZodDefault) return baseType(type.removeDefault());
  return type;
}

function coerce(type: z.ZodTypeAny, raw: string): unknown {
  const base = baseType(type);
  if (base instanceof z.ZodNumber) {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`Expected a number, got "${raw}".`);
    return n;
  }
  if (base instanceof z.ZodBoolean) {
    if (["true", "1", "yes"].includes(raw.toLowerCase())) return true;
    if (["false", "0", "no"].includes(raw.toLowerCase())) return false;
    throw new Error(`Expected true or false, got "${raw}".`);
  }
  return raw;
}

function isArray(type: z.ZodTypeAny): boolean {
  return baseType(type) instanceof z.ZodArray;
}

function isBoolean(type: z.ZodTypeAny): boolean {
  return baseType(type) instanceof z.ZodBoolean;
}

function elementType(type: z.ZodTypeAny): z.ZodTypeAny {
  const base = baseType(type);
  return base instanceof z.ZodArray ? (base.element as z.ZodTypeAny) : base;
}

export function parseArgs(action: ActionDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positionals: string[] = [];
  const shape = action.schema as Record<string, z.ZodTypeAny>;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      let name = token.slice(2);
      let value: string | undefined;

      const eq = name.indexOf("=");
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      let negated = false;
      if (name.startsWith("no-") && !(name.replace(/-/g, "_") in shape)) {
        negated = true;
        name = name.slice(3);
      }

      const key = name.replace(/-/g, "_");
      const type = shape[key];
      if (!type) {
        throw new Error(`Unknown option --${name} for "${action.name}". Run 'agentbrowser help ${action.name}'.`);
      }

      if (isBoolean(type)) {
        out[key] = value !== undefined ? coerce(type, value) : !negated;
        continue;
      }

      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new Error(`Option --${name} needs a value.`);
      }

      if (isArray(type)) {
        const list = (out[key] as unknown[]) ?? [];
        list.push(coerce(elementType(type), value));
        out[key] = list;
      } else {
        out[key] = coerce(type, value);
      }
      continue;
    }

    positionals.push(token);
  }

  const order = action.positional ?? [];
  for (let i = 0; i < order.length; i++) {
    const key = order[i]!;
    const type = shape[key];
    if (!type) continue;
    if (out[key] !== undefined) continue;

    const isLast = i === order.length - 1;
    if (action.variadic && isLast && isArray(type)) {
      const rest = positionals.slice(i);
      if (rest.length) out[key] = rest.map((value) => coerce(elementType(type), value));
      continue;
    }
    const value = positionals[i];
    if (value === undefined) continue;
    out[key] = isArray(type) ? [coerce(elementType(type), value)] : coerce(type, value);
  }

  return out;
}

export function usageFor(action: ActionDef): string {
  const shape = action.schema as Record<string, z.ZodTypeAny>;
  const positional = (action.positional ?? [])
    .filter((key) => key in shape)
    .map((key) => {
      const type = shape[key]!;
      const optional = type.isOptional();
      const variadic = action.variadic && key === action.positional?.[action.positional.length - 1] && isArray(type);
      const label = `<${key}${variadic ? "..." : ""}>`;
      return optional ? `[${label}]` : label;
    })
    .join(" ");

  const lines: string[] = [];
  lines.push(`agentbrowser ${action.name}${positional ? " " + positional : ""}`);
  lines.push("");
  lines.push(action.description);

  const options = Object.entries(shape);
  if (options.length) {
    lines.push("");
    lines.push("Options:");
    for (const [key, type] of options) {
      const flag = `--${key.replace(/_/g, "-")}${isBoolean(type) ? "" : " <value>"}`;
      const describedType = type as unknown as { description?: string };
      lines.push(`  ${flag.padEnd(26)} ${describedType.description ?? ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}
