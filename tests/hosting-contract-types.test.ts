import { expect, test } from 'bun:test';
import ts from 'typescript';
import { resolve } from 'node:path';

test('shared hosting contracts compile with role narrowing and expected privacy errors', () => {
  const file = resolve(import.meta.dir, 'hosting-contract-types.ts');
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['bun'],
  });
  // Check the assertion file against the real imported declarations. Unrelated
  // repository diagnostics are reported separately by the broad typecheck.
  const source = program.getSourceFile(file)!;
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  })).toBe('');
});
