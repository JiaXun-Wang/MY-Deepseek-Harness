import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-lark-link";
declare const inject: string[];
interface LarkLinkConfig {
  enabled?: boolean;
  groupPolicy?: "open" | "mention" | "keywords" | "reply";
  denyList?: string[];
}
/** Bridge state directory (<DSH_HOME>/lark-link, overridable). */
declare function stateDir(): string;
declare function apply(ctx: Context, rawConfig: unknown): void;
//#endregion
export { LarkLinkConfig, apply, inject, name, stateDir };