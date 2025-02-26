import { workspace, Uri, OutputChannel, window, FileSystemWatcher, Disposable, ProgressLocation, CancellationToken, CancellationTokenSource } from "vscode";
import * as Path from "path";
import { AsmProvider } from "./provider";
import { SpawnOptionsWithStdioTuple, StdioPipe, StdioNull, ChildProcess, spawn } from 'child_process';
import { TextDecoder } from "util";
import { existsSync, promises as fs } from "fs";
import { splitLines } from "./utils";

interface CompileCommand {
    directory: string,
    command: string,
    file: string,
    arguments: string[]
}

const cxxfiltExe = 'c++filt';

export class CompilationDatabase implements Disposable {
    private compileCancellationTokenSource?: CancellationTokenSource = undefined;
    private compileCommandsFile: Uri;
    private commands: Map<string, CompileCommand>;
    private cxxFiltExeCache: Map<string, string> = new Map();
    private watcher: FileSystemWatcher;

    private static compdbs: Map<Uri, CompilationDatabase> = new Map();

    constructor(compileCommandsFile: Uri, commands: Map<string, CompileCommand>) {
        this.compileCommandsFile = compileCommandsFile;
        this.commands = commands;
        this.watcher = workspace.createFileSystemWatcher(this.compileCommandsFile.path);

        const load = async () => {
            getOutputChannel().appendLine(`Loading compile commands1`);
            this.commands = await CompilationDatabase.load(this.compileCommandsFile);
            getOutputChannel().appendLine(`Loaded compile commands1`);
        };
        this.watcher.onDidChange(async () => await load());
        this.watcher.onDidDelete(() => {
            CompilationDatabase.compdbs.get(this.compileCommandsFile)?.dispose();
            CompilationDatabase.compdbs.delete(this.compileCommandsFile);
        });
    }

    static async for(srcUri: Uri): Promise<CompilationDatabase> {
        const buildDirectory = resolvePath(workspace.getConfiguration('compilerexplorer')
            .get<string>('compilationDirectory', '${workspaceFolder}'), srcUri);
        const compileCommandsFile = Uri.joinPath(Uri.parse(buildDirectory), 'compile_commands.json');

        let compdb = CompilationDatabase.compdbs.get(compileCommandsFile);
        if (compdb) {
            return compdb;
        }
        const commands = await CompilationDatabase.load(compileCommandsFile);

        compdb = new CompilationDatabase(compileCommandsFile, commands);
        this.compdbs.set(compileCommandsFile, compdb);

        return compdb;
    }

    get(srcUri: Uri): CompileCommand | undefined {
        const buildDirectory = resolvePath(workspace.getConfiguration('compilerexplorer')
            .get<string>('compilationDirectory', '${workspaceFolder}'), srcUri);
        // const abs_filepath = Uri.joinPath(Uri.parse(buildDirectory), srcUri.fsPath);
        const relativeFp = srcUri.fsPath.replace(buildDirectory+"/", "");

        getOutputChannel().appendLine(`get command for file ${relativeFp}`);
        return this.commands.get(relativeFp);
    }

    async compile(src: Uri, customCommand: string[]): Promise<string> {
        const ccommand = this.get(src);
        if (!ccommand) throw new Error("cannot find compilation command " + src);

        // cancel possible previous compilation
        this.compileCancellationTokenSource?.cancel();

        const ctokSource = new CancellationTokenSource();
        this.compileCancellationTokenSource = ctokSource;

        try {
            const start = new Date().getTime();

            const progressOption = {
                location: ProgressLocation.Notification,
                title: "C++ Compiler Explorer",
                cancellable: true
            };

            const asm = await window.withProgress(progressOption,
                async (progress, ctok) => {
                    progress.report({ message: "Compilation in progress" });
                    ctok.onCancellationRequested(() => ctokSource.cancel());
                    return await this.runCompiler(ctokSource.token, ccommand, customCommand);
                });
            const elapsed = (new Date().getTime() - start) / 1000;
            getOutputChannel().appendLine(`Compilation succeeded: ${asm.length} bytes, ${elapsed} s`);
            return asm;
        } finally {
            this.compileCancellationTokenSource = undefined;
        }
    }

    static disposable(): Disposable {
        return new Disposable(() => {
            for (let compdb of this.compdbs) {
                compdb[1].dispose();
            }
        });
    }

    private static async load(compileCommandsFile: Uri): Promise<Map<string, CompileCommand>> {
        getOutputChannel().appendLine(`Loading Compilation Database from: ${compileCommandsFile.toString()}`);

        const compileCommands = new TextDecoder().decode(await workspace.fs.readFile(compileCommandsFile));
        const commands: CompileCommand[] = JSON.parse(compileCommands);
        CompilationDatabase.preprocess(commands);

        let ccommands = new Map<string, CompileCommand>();
        for (let command of commands) {
            getOutputChannel().appendLine(`command: ${JSON.stringify(command)}`);
            ccommands.set(command.file, command);
        }
        getOutputChannel().appendLine(`ccommands size: ${ccommands.size}`);

        return ccommands;
    }

    private static preprocess(commands: CompileCommand[]) {
        for (let ccommand of commands) {
            ccommand.arguments = constructCompileCommand(ccommand.command, ccommand.arguments, ccommand.directory);
            ccommand.arguments = ccommand.arguments.filter((arg) => arg != ccommand.file);
            ccommand.command = "";
        }
    }

    private async runCompiler(ctok: CancellationToken, ccommand: CompileCommand, customCommand: string[]): Promise<string> {
        const compileArguments = customCommand.length != 0 ? customCommand : ccommand.arguments;
        const cxxfiltExe = await this.getCxxFiltExe(compileArguments[0]);
        const command =
            // "BAZEL_USE_CPP_ONLY_TOOLCHAIN=1 " +
            // "DEVELOPER_DIR=\"/Applications/Xcode.app/Contents/Developer\" " +
            // "SDKROOT=\"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX13.3.sdk\" " +
            compileArguments[0];

        var args = [...compileArguments.slice(1), workspace.workspaceFolders[0].uri.path + "/" + ccommand.file, '-g', '-S', '-o', '-'];
        getOutputChannel().appendLine(`args: ${command} ${args}`);

        args = args.map(item => (item === "-D\"BAZEL_CURRENT_REPOSITORY=\"\"\"") ? "-DBAZEL_CURRENT_REPOSITORY=\"\"" : item);

        getOutputChannel().appendLine(`Compiling using: ${command} ${args.join(' ')}`);
        getOutputChannel().appendLine(`cxxfiltExe: ${cxxfiltExe}`);

        const env: NodeJS.ProcessEnv = {
            BAZEL_USE_CPP_ONLY_TOOLCHAIN: '1',
            DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
            SDKROOT: '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX13.3.sdk',
        };

        let commandOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = { stdio: ['ignore', 'pipe', 'pipe'], env };

        if (existsSync(ccommand.directory)) {
            commandOptions.cwd = ccommand.directory;
        }
        const cxx = spawn(command, args, commandOptions);
        const cxxfilt = spawn(cxxfiltExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });

        cxx.stdout.on('data', (data) => {
            getOutputChannel().appendLine(`stdout: ${data}`);
        });

        cxx.stderr.on('data', (data) => {
            getOutputChannel().appendLine(`stderr: ${data}`);
        });

        cxx.on('close', (code) => {
            getOutputChannel().appendLine(`Compilation process exited with code ${code}`);
        });

        cxx.on('error', (error: Error) => {
            throw new Error(`Compilation process got error ${error}`);
        });

        try {
            cxxfilt.stdin.cork();

            for await (let chunk of cxx.stdout!) {
                if (ctok.isCancellationRequested) throw new Error("operation cancelled");
                cxxfilt.stdin.write(chunk);
                getOutputChannel().appendLine(`1: ${cxxfiltExe}`);

            }
            getOutputChannel().appendLine(`2: ${cxxfiltExe}`);

            cxxfilt.stdin.uncork();
            cxxfilt.stdin.end();

            if (!await this.checkStdErr(cxx)) throw new Error("compilation failed");

            let asm = ""
            for await (let chunk of cxxfilt.stdout!) {
                if (ctok.isCancellationRequested) throw new Error("operation cancelled");
                asm += chunk;
            }
            if (!await this.checkStdErr(cxxfilt)) throw new Error("compilation failed");

            return splitLines(asm).filter((line) => {
                line = line.trimStart();
                return !line.startsWith('#') && !line.startsWith(';')
            }).join('\n');
        } catch (e) {
            cxx.kill();
            cxxfilt.kill();
            throw e;
        }
    }

    private async getCxxFiltExe(compExe: string): Promise<string> {
        let cxxfiltExe = this.cxxFiltExeCache.get(compExe)
        if (cxxfiltExe !== undefined)
            return cxxfiltExe;

        cxxfiltExe = await this.findCxxFiltExe(compExe);
        this.cxxFiltExeCache.set(compExe, cxxfiltExe);

        return cxxfiltExe;
    }

    private async findCxxFiltExe(compExe: string): Promise<string> {
        let parsed = Path.parse(compExe)
        let findExePath = async (dir: string | undefined) => {
            if (dir !== undefined) {
                const cxxfiltNameWithExt = cxxfiltExe + parsed.ext;
                for (let file of await fs.readdir(dir)) {
                    if (file.endsWith(cxxfiltNameWithExt)) {
                        return Path.resolve(dir, file);
                    }
                }
            }

            return undefined;
        };

        // Use PATH or base dir of compiler to find c++filt executable
        if (parsed.dir.length == 0) {
            // Compiler base path is empty, so check expand in PATH.
            const compExeDir = await this.findExecutablePath(compExe);
            const cxxfilt = await findExePath(compExeDir);
            if (cxxfilt !== undefined) {
                return cxxfilt;
            }
        } else {
            // Use the path in which the compiler is installed.
            const compExeDir = parsed.dir;
            const cxxfilt = await findExePath(compExeDir);
            if (cxxfilt !== undefined) {
                return cxxfilt;
            }
        }

        // Else guess the path and hope it turns useful.
        parsed.name = parsed.name.replace('clang++', cxxfiltExe)
            .replace('clang', cxxfiltExe)
            .replace('g++', cxxfiltExe)
            .replace('gcc', cxxfiltExe)
            .replace('c++', cxxfiltExe)
            .replace('cc', cxxfiltExe);

        const cxxfilt = Path.join(parsed.dir, parsed.name, parsed.ext);
        if (!existsSync(cxxfilt)) return cxxfiltExe;

        return cxxfilt;
    }

    private async findExecutablePath(exe: string): Promise<string | undefined> {
        let commandOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioNull> = { stdio: ['ignore', 'pipe', 'ignore'] }
        const which = spawn("which", [exe], commandOptions);

        try {
            let resolvedPath = "";
            for await (let chunk of which.stdout!) {
                resolvedPath += chunk.toString();
            }
            if (!await this.checkStdErr(which)) return Path.parse(resolvedPath).dir;
        } catch (e) {
            which.kill();
        }
        return undefined;
    }

    private async checkStdErr(process: ChildProcess) {
        let stderr = "";
        for await (let chunk of process.stderr!) {
            stderr += chunk;
        }
        if (stderr.length > 0) {
            getOutputChannel().appendLine(stderr);
            getOutputChannel().show();
        }

        try {
            if (await onExit(process)) return false;
        } catch (e) {
            return false;
        }

        return true;
    }

    dispose() {
        this.compileCancellationTokenSource?.cancel();
        this.compileCancellationTokenSource?.dispose();
        this.commands.clear();
        this.watcher.dispose();
    }
}

export function constructCompileCommand(command: string, args: string[], directory: string): string[] {
    if (command.length > 0) {
        args = splitWhitespace(command);
    }
    args[0] = directory + '/' + args[0];

    let isOutfile = false;
    args = args.filter(arg => {
        if (!isOutfile) {
            isOutfile = arg === "-o";
            return isOutfile ? false : arg !== "-c" && arg !== "-g";
        } else {
            isOutfile = false;
            return false;
        }
    });

    return args;
}

export function getAsmUri(srcUri: Uri): Uri {
    // by default just replace file extension with '.S'
    const asmUri = srcUri.with({
        scheme: AsmProvider.scheme,
        path: pathWithoutExtension(srcUri.path) + ".S",
    });

    return asmUri;
}

/**
 * Remove extension from provided path.
 */
function pathWithoutExtension(path: string): string {
    return path.slice(0, path.lastIndexOf(".")) || path;
}

// Resolve path with almost all variable substitution that supported in
// Debugging and Task configuration files
function resolvePath(path: string, srcUri: Uri): string {
    const workspacePath = workspace.getWorkspaceFolder(srcUri)?.uri.fsPath!;

    const variables: Record<string, string> = {
        // the path of the folder opened in VS Code
        workspaceFolder: workspacePath,
        // the name of the folder opened in VS Code without any slashes (/)
        workspaceFolderBasename: Path.parse(workspacePath).name,
        // the current opened file
        file: path,
        // the current opened file's workspace folder
        fileWorkspaceFolder:
            workspace.getWorkspaceFolder(Uri.file(path))?.uri.fsPath || "",
        // the current opened file relative to workspaceFolder
        relativeFile: Path.relative(workspacePath, path),
        // the character used by the operating system to separate components in file paths
        pathSeparator: Path.sep,
    };

    const variablesRe = /\$\{(.*?)\}/g;
    const resolvedPath = path.replace(
        variablesRe,
        (match: string, varName: string) => {
            const value = variables[varName];
            if (value !== undefined) {
                return value;
            } else {
                // leave original (unsubstituted) value if there is no such variable
                return match;
            }
        }
    );

    // normalize a path, reducing '..' and '.' parts
    return Path.normalize(resolvedPath);
}

let outputChannel: OutputChannel | undefined = undefined;
export function getOutputChannel(): OutputChannel {
    if (outputChannel === undefined)
        outputChannel = window.createOutputChannel("C/C++ Compiler Explorer", "shellscript");
    return outputChannel;
}

async function onExit(childProcess: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        childProcess.once('exit', (code: number, signal: string) => {
            resolve(code);
        });
        childProcess.once('error', (err: Error) => {
            reject(err);
        });
    });
}

function splitWhitespace(str: string): string[] {
    let quoteChar: string | undefined = undefined;
    let shouldEscape = false;
    let strs: string[] = [];

    let i = 0;
    let strStart = 0;
    for (let ch of str) {
        switch (ch) {
            case '\\':
                shouldEscape = !shouldEscape;
                break;

            case '\'':
                if (!shouldEscape) {
                    if (quoteChar == '\'') quoteChar = undefined;
                    else quoteChar = '\'';
                }
                break;
            case '"':
                if (!shouldEscape) {
                    if (quoteChar == '"') quoteChar = undefined;
                    else quoteChar = '"';
                }
                break;

            case ' ':
                if (!quoteChar) {
                    const slice = str.slice(strStart, i);
                    if (slice.length > 0) strs.push(slice);
                    strStart = i + 1;
                }

            default:
                break;
        }

        i++;
    }

    const slice = str.slice(strStart, i);
    if (slice.length > 0) strs.push(slice);

    return strs;
}
