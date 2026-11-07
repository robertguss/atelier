// A stand-in Convex client for the room tools' tests: records every query and
// mutation by name and answers from `replies`.
import { getFunctionName } from "convex/server";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReference_future,
  FunctionReturnType,
} from "convex/server";

export type FakeArgs = Record<string, unknown>;

export class FakeRoomConvex {
  readonly calls: { name: string; args: FakeArgs }[] = [];
  readonly replies: Record<string, (args: FakeArgs) => unknown>;

  constructor(replies: Record<string, (args: FakeArgs) => unknown> = {}) {
    this.replies = replies;
  }

  query<
    Query extends
      | FunctionReference<"query">
      | FunctionReference_future<"query">,
  >(
    ref: Query,
    args: FunctionArgs<Query>
  ): Promise<Awaited<FunctionReturnType<Query>>>;
  async query(
    ref: FunctionReference<"query"> | FunctionReference_future<"query">,
    args: FakeArgs
  ): Promise<unknown> {
    return await this.answer(ref, args);
  }

  mutation<
    Mutation extends
      | FunctionReference<"mutation">
      | FunctionReference_future<"mutation">,
  >(
    ref: Mutation,
    args: FunctionArgs<Mutation>
  ): Promise<Awaited<FunctionReturnType<Mutation>>>;
  async mutation(
    ref: FunctionReference<"mutation"> | FunctionReference_future<"mutation">,
    args: FakeArgs
  ): Promise<unknown> {
    return await this.answer(ref, args);
  }

  private async answer(
    ref:
      | FunctionReference<"query" | "mutation">
      | FunctionReference_future<"query" | "mutation">,
    args: FakeArgs
  ) {
    const name = getFunctionName(ref);
    this.calls.push({ args, name });
    return await Promise.resolve(this.replies[name]?.(args));
  }
}
