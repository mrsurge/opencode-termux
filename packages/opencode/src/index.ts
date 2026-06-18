import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EOL } from "os"
import { Heap } from "./cli/heap"

const args = hideBin(process.argv)

function show(out: string, UI: typeof import("./cli/ui").UI) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

function baseCli() {
  return yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
}

const commandName = args.find((arg) => !arg.startsWith("-"))

if (commandName === "app-server") {
  const { AppServerCommand } = await import("./cli/cmd/app-server")
  try {
    await baseCli().command(AppServerCommand).strict().parse()
  } catch (e) {
    process.stderr.write(String(e instanceof Error ? e.message : e) + EOL)
    process.exitCode = 1
  } finally {
    process.exit()
  }
}

const { RunCommand } = await import("./cli/cmd/run")
const { GenerateCommand } = await import("./cli/cmd/generate")
const { ConsoleCommand } = await import("./cli/cmd/account")
const { ProvidersCommand } = await import("./cli/cmd/providers")
const { AgentCommand } = await import("./cli/cmd/agent")
const { UpgradeCommand } = await import("./cli/cmd/upgrade")
const { UninstallCommand } = await import("./cli/cmd/uninstall")
const { ModelsCommand } = await import("./cli/cmd/models")
const { UI } = await import("./cli/ui")
const { FormatError } = await import("./cli/error")
const { ServeCommand } = await import("./cli/cmd/serve")
const { DebugCommand } = await import("./cli/cmd/debug")
const { StatsCommand } = await import("./cli/cmd/stats")
const { McpCommand } = await import("./cli/cmd/mcp")
const { GithubCommand } = await import("./cli/cmd/github")
const { ExportCommand } = await import("./cli/cmd/export")
const { ImportCommand } = await import("./cli/cmd/import")
const { AttachCommand } = await import("./cli/cmd/attach")
const { TuiThreadCommand } = await import("./cli/cmd/tui")
const { AcpCommand } = await import("./cli/cmd/acp")
const { WebCommand } = await import("./cli/cmd/web")
const { PrCommand } = await import("./cli/cmd/pr")
const { SessionCommand } = await import("./cli/cmd/session")
const { DbCommand } = await import("./cli/cmd/db")
const { errorMessage } = await import("./util/error")
const { PluginCommand } = await import("./cli/cmd/plug")
const { AppServerCommand } = await import("./cli/cmd/app-server")

const cli = baseCli()
  .command(AcpCommand)
  .command(AppServerCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp((out) => show(out, UI))
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out, UI)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
