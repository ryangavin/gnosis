/**
 * gnosis <command> <repo> — dispatch only; each command owns its flags.
 */
const HELP = `gnosis — a self-maintaining knowledge graph for codebases

usage:
  gnosis scan  <repo>                    static analysis → graph.json
  gnosis trace <repo> [-- vitest args]   run the target's tests instrumented; overlay the graph
  gnosis serve <repo> [--port 4400]      interactive two-layer visualization
  gnosis mcp   <repo>                    MCP server over stdio
  gnosis emit  <repo> [--out <dir>]      markdown architecture summaries
`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'scan': {
      const { runScan } = await import('./commands/scan.ts');
      return runScan(rest);
    }
    case 'trace': {
      const { runTrace } = await import('./commands/trace.ts');
      return runTrace(rest);
    }
    case 'serve': {
      const { runServe } = await import('./commands/serve.ts');
      return runServe(rest);
    }
    case 'mcp': {
      const { runMcp } = await import('./commands/mcp.ts');
      return runMcp(rest);
    }
    case 'emit': {
      const { runEmit } = await import('./commands/emit.ts');
      return runEmit(rest);
    }
    default:
      process.stdout.write(HELP);
      if (command !== undefined && command !== 'help' && command !== '--help') {
        process.exitCode = 1;
      }
  }
}
