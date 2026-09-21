import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import * as Effect from "effect/Effect"

import type * as Firecracker from "./Firecracker.js"
import type * as Workspace from "./Workspace.js"

const toolResult = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
  render: (value: A) => string,
  signal: AbortSignal | undefined
) => Effect.runPromise(effect.pipe(
  Effect.match({
    onFailure: (error) => ({
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      details: { ok: false, message: error.message }
    }),
    onSuccess: (value) => ({
      content: [{ type: "text" as const, text: render(value) }],
      details: { ok: true }
    })
  })
), signal === undefined ? undefined : { signal })

export interface Tools {
  readonly names: ReadonlyArray<string>
  readonly definitions: ReadonlyArray<ToolDefinition>
}

export const make = (workspace: Workspace.Workspace, firecracker: Firecracker.Firecracker): Tools => {
  const readFile = defineTool({
    name: "read_file",
    label: "Read file",
    description: "Read one UTF-8 file from the virtual project workspace. Paths are relative to the project root.",
    promptSnippet: "read_file: read a UTF-8 project file",
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative file path" })
    }),
    executionMode: "parallel" as const,
    execute: (_toolCallId, { path }, signal) => toolResult(
      workspace.read(path),
      (content) => content,
      signal
    )
  })

  const listDirectory = defineTool({
    name: "list_directory",
    label: "List directory",
    description: "List direct children of a directory in the virtual project workspace. Use an empty path for the project root.",
    promptSnippet: "list_directory: list a virtual project directory",
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative directory path, or empty for root" })
    }),
    executionMode: "parallel" as const,
    execute: (_toolCallId, { path }, signal) => toolResult(
      workspace.list(path),
      (entries) => entries.join("\n"),
      signal
    )
  })

  const writeFile = defineTool({
    name: "write_file",
    label: "Write file",
    description: "Create or replace one UTF-8 file in the virtual project workspace.",
    promptSnippet: "write_file: replace a virtual project file",
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative file path" }),
      content: Type.String({ description: "Complete new UTF-8 file contents" })
    }),
    executionMode: "sequential" as const,
    execute: (_toolCallId, { path, content }, signal) => toolResult(
      workspace.write(path, content),
      () => `Wrote ${path}`,
      signal
    )
  })

  const editFile = defineTool({
    name: "edit_file",
    label: "Edit file",
    description: "Replace one exact, unique text fragment in a UTF-8 file in the virtual project workspace.",
    promptSnippet: "edit_file: replace exact text in a virtual project file",
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative file path" }),
      oldText: Type.String({ description: "Exact text that must occur once" }),
      newText: Type.String({ description: "Replacement text" })
    }),
    executionMode: "sequential" as const,
    execute: (_toolCallId, { path, oldText, newText }, signal) => toolResult(
      workspace.edit(path, oldText, newText),
      () => `Edited ${path}`,
      signal
    )
  })

  const runTests = defineTool({
    name: "run_tests",
    label: "Run tests in Firecracker",
    description: "Commit the current virtual workspace and run its Node test suite in a fresh Firecracker microVM. Use this after editing and repeat until tests pass.",
    promptSnippet: "run_tests: checkpoint the workspace and run tests in Firecracker",
    promptGuidelines: ["Run the tests after making a change. Do not claim success unless run_tests reports PASS."],
    parameters: Type.Object({}),
    executionMode: "sequential" as const,
    execute: (_toolCallId, _params, signal) => toolResult(
      workspace.checkpoint("before test").pipe(
        Effect.flatMap((checkpoint) => firecracker.test(workspace.repository, checkpoint.commit))
      ),
      (result) => [
        `Tests: ${result.passed ? "PASS" : "FAIL"}`,
        `Commit: ${result.commit}`,
        `Firecracker duration: ${result.durationMillis}ms`,
        "",
        result.output.slice(-20_000)
      ].join("\n"),
      signal
    )
  })

  const definitions = [readFile, listDirectory, writeFile, editFile, runTests]
  return {
    names: definitions.map((tool) => tool.name),
    definitions
  }
}
