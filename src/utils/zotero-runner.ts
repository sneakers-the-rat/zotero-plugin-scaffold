import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { delay } from "es-toolkit";
import { outputFile, outputJSON, pathExists, readJSON, remove } from "fs-extra/esm";
import { isLinux, isMacOS, isWindows } from "std-env";
import { logger } from "./log.js";
import { isRunning } from "./process.js";
import { prefs } from "./zotero/preference.js";
import { findFreeTcpPort, RemoteFirefox } from "./zotero/remote-zotero.js";

export interface ZoteroRunnerOptions {
  binaryPath: string;
  profilePath: string;
  dataDir: string;
  customPrefs?: { [key: string]: string | number | boolean };

  plugins: PluginInfo[];
  asProxy?: boolean;

  devtools?: boolean;
  binaryArgs?: string[];
}

interface PluginInfo {
  id: string;
  sourceDir: string;
}

export class ZoteroRunner {
  private options: ZoteroRunnerOptions;
  private remoteFirefox: RemoteFirefox;
  public zotero?: ChildProcessWithoutNullStreams;

  constructor(options: ZoteroRunnerOptions) {
    this.options = options;
    this.remoteFirefox = new RemoteFirefox();
  }

  async run() {
    // Get a Zotero profile with the custom Prefs set (a new or a cloned one)
    // Pre-install extensions as proxy if needed (and disable auto-reload if you do)
    await this.setupProfileDir();

    // Start Zotero process and connect to the Zotero instance on RDP
    await this.startZoteroInstance();

    // Install any extension if not in proxy mode
    if (!this.options.asProxy)
      await this.installTemporaryPlugins();
  }

  /**
   * Preparing the development environment
   *
   * When asProxy=true, generate a proxy file and replace prefs.
   *
   * @see https://www.zotero.org/support/dev/client_coding/plugin_development#setting_up_a_plugin_development_environment
   */
  private async setupProfileDir() {
    if (!this.options.profilePath) {
      // Create profile
    }

    // Setup prefs.js
    const defaultPrefs = Object.entries(prefs).map(([key, value]) => {
      return `user_pref("${key}", ${JSON.stringify(value)});`;
    });
    const customPrefs = Object.entries(this.options.customPrefs || []).map(([key, value]) => {
      return `user_pref("${key}", ${JSON.stringify(value)});`;
    });

    let exsitedPrefs: string[] = [];
    const prefsPath = join(this.options.profilePath, "prefs.js");
    if (await pathExists(prefsPath)) {
      const PrefsLines = (await readFile(prefsPath, "utf-8")).split("\n");
      exsitedPrefs = PrefsLines.map((line: string) => {
        if (
          line.includes("extensions.lastAppBuildId")
          || line.includes("extensions.lastAppVersion")
        ) {
          return "";
        }
        return line;
      });
    }
    const updatedPrefs = [...defaultPrefs, ...exsitedPrefs, ...customPrefs].join("\n");
    await outputFile(prefsPath, updatedPrefs, "utf-8");
    logger.debug("The <profile>/prefs.js has been modified.");

    // Install plugins in proxy file mode
    if (this.options.asProxy) {
      await this.installProxyPlugins();
    }
  }

  private async startZoteroInstance() {
    // Build args
    let args: string[] = ["--purgecaches", "no-remote"];
    if (this.options.profilePath) {
      args.push("-profile", resolve(this.options.profilePath));
    }
    if (this.options.dataDir) {
      // '--dataDir' required absolute path
      args.push("--dataDir", resolve(this.options.dataDir));
    }
    if (this.options.devtools) {
      args.push("--jsdebugger");
    }
    if (this.options.binaryArgs) {
      args = [...args, ...this.options.binaryArgs];
    }

    // support for starting the remote debugger server
    const remotePort = await findFreeTcpPort();
    args.push("-start-debugger-server", String(remotePort));

    const env = {
      ...process.env,
      XPCOM_DEBUG_BREAK: "stack",
      NS_TRACE_MALLOC_DISABLE_STACKS: "1",
    };

    // Using `spawn` so we can stream logging as they come in, rather than
    // buffer them up until the end, which can easily hit the max buffer size.
    this.zotero = spawn(this.options.binaryPath, args, { env });

    // Handle Zotero log, necessary on macOS
    this.zotero.stdout?.on("data", (_data) => {});

    await this.remoteFirefox.connect(remotePort);
    logger.debug(`Connected to the remote Firefox debugger on port: ${remotePort}`);
  }

  private async installTemporaryPlugins() {
    // Install all the temporary addons.
    for (const plugin of this.options.plugins) {
      const addonId = await this.remoteFirefox
        .installTemporaryAddon(resolve(plugin.sourceDir))
        .then((installResult) => {
          return installResult.addon.id;
        });

      if (!addonId) {
        throw new Error("Unexpected missing addonId in the installAsTemporaryAddon result");
      }
    }
  }

  private async installProxyPlugin(id: string, sourceDir: string) {
    // Create a proxy file
    const addonProxyFilePath = join(this.options.profilePath, `extensions/${id}`);
    const buildPath = resolve(sourceDir);

    await outputFile(addonProxyFilePath, buildPath);
    logger.debug(
      [
        `Addon proxy file has been updated.`,
        `  File path: ${addonProxyFilePath}`,
        `  Addon path: ${buildPath}`,
      ].join("\n"),
    );

    // Delete XPI file
    const addonXpiFilePath = join(this.options.profilePath, `extensions/${id}.xpi`);
    if (await pathExists(addonXpiFilePath)) {
      await remove(addonXpiFilePath);
      logger.debug(`XPI file found, removed.`);
    }

    // Force enable plugin in extensions.json
    const addonInfoFilePath = join(this.options.profilePath, "extensions.json");
    if (await pathExists(addonInfoFilePath)) {
      const content = await readJSON(addonInfoFilePath);
      content.addons = content.addons.map((addon: any) => {
        if (addon.id === id && addon.active === false) {
          addon.active = true;
          addon.userDisabled = false;
          logger.debug(`Active plugin ${id} in extensions.json.`);
        }
        return addon;
      });
      await outputJSON(addonInfoFilePath, content);
    }
  }

  private async installProxyPlugins() {
    for (const { id, sourceDir } of this.options.plugins) {
      await this.installProxyPlugin(id, sourceDir);
    }
  }

  public async reloadTemporaryPluginById(id: string) {
    await this.remoteFirefox.reloadAddon(id);
  }

  public async reloadTemporaryPluginBySourceDir(sourceDir: string) {
    const addonId = this.options.plugins.find(p => p.sourceDir === sourceDir)?.id;

    if (!addonId) {
      return {
        sourceDir,
        reloadError: new Error(
          "Extension not reloadable: "
          + `no addonId has been mapped to "${sourceDir}"`,
        ),
      };
    }

    try {
      await this.remoteFirefox.reloadAddon(addonId);
    }
    catch (error) {
      return {
        sourceDir,
        reloadError: error,
      };
    }

    return { sourceDir, reloadError: undefined };
  }

  private async reloadAllTemporaryPlugins() {
    for (const { sourceDir } of this.options.plugins) {
      const res = await this.reloadTemporaryPluginBySourceDir(sourceDir);
      if (res.reloadError instanceof Error) {
        logger.error(res.reloadError);
      }
    }
  }

  public async reloadProxyPluginByZToolkit(id: string, name: string, version: string) {
    const reloadScript = `
    (async () => {
    Services.obs.notifyObservers(null, "startupcache-invalidate", null);
    const { AddonManager } = ChromeUtils.import("resource://gre/modules/AddonManager.jsm");
    const addon = await AddonManager.getAddonByID("${id}");
    await addon.reload();
    const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWindow.changeHeadline("${name} Hot Reload");
    progressWindow.progress = new progressWindow.ItemProgress(
        "chrome://zotero/skin/tick.png",
        "VERSION=${version}, BUILD=${new Date().toLocaleString()}. By zotero-plugin-toolkit"
    );
    progressWindow.progress.setProgress(100);
    progressWindow.show();
    progressWindow.startCloseTimer(5000);
    })()`;
    const url = `zotero://ztoolkit-debug/?run=${encodeURIComponent(
      reloadScript,
    )}`;
    const startZoteroCmd = `"${this.options.binaryPath}" --purgecaches -profile "${this.options.profilePath}"`;
    const command = `${startZoteroCmd} -url "${url}"`;
    execSync(command);
  }

  // Do not use this method if possible,
  // as frequent execSync can cause Zotero to crash.
  private async reloadAllProxyPlugins() {
    for (const { id } of this.options.plugins) {
      await this.reloadProxyPluginByZToolkit(id, id, id);
      await delay(2000);
    }
  }

  public async reloadAllPlugins() {
    if (this.options.asProxy)
      await this.reloadAllProxyPlugins();
    else
      await this.reloadAllTemporaryPlugins();
  }

  public exit() {
    this.zotero?.kill();
    // Sometimes `process.kill()` cannot kill the Zotero,
    // so we force kill it.
    killZotero();
  }
}

export function killZotero() {
  function kill() {
    try {
      if (process.env.ZOTERO_PLUGIN_KILL_COMMAND) {
        execSync(process.env.ZOTERO_PLUGIN_KILL_COMMAND);
      }
      else if (isWindows) {
        execSync("taskkill /f /im zotero.exe");
      }
      else if (isMacOS) {
        execSync("kill -9 $(ps -x | grep zotero)");
      }
      else if (isLinux) {
        execSync("pkill -9 zotero");
      }
      else {
        logger.error("No commands found for this operating system.");
      }
    }
    catch {
      logger.fail("Kill Zotero failed.");
    }
  }

  if (isRunning("zotero")) {
    kill();
  }
  else {
    logger.fail("No Zotero instance is currently running.");
  }
}
