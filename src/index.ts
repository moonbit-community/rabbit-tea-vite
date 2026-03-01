import type { Plugin, ViteDevServer } from 'vite';
import { spawnSync } from 'child_process';
import { cpSync } from 'fs';
import fs from 'fs';
import path from 'path';

type MoonModConfig = {
  source: string,
  modPath: string,
}

type MoonPkgConfig = {
  // package path in mooncakes.io
  packagePath: string,
  // package path relative to the module path in mooncakes.io 
  relativePath: string,
  isMain: boolean,
  lastPath: string
}

function probeMoonBitPackage(sourceRoot: string, modConfig: MoonModConfig): Array<MoonPkgConfig> {
  const pkgConfigs: Array<MoonPkgConfig> = [];
  const worklist: Array<string> = [sourceRoot];
  while (worklist.length > 0) {
    const current = worklist.pop()!
    fs.readdirSync(current).forEach((x) => {
      const file = path.join(current, x)
      const stat = fs.statSync(file);
      if (stat.isDirectory() && path.basename(file) != ".mooncakes") {
        worklist.push(file)
      } else if (file.endsWith("moon.pkg.json")) {
        try {
          const pkgConfig = JSON.parse(fs.readFileSync(file).toString());
          const relativePath = path.dirname(file.substring(sourceRoot.length + 1));
          const packagePath = path.join(modConfig.modPath, relativePath);
          pkgConfigs.push({
            isMain: pkgConfig["is-main"] ? true : false,
            relativePath,
            packagePath,
            lastPath: path.basename(packagePath)
          });
        }
        catch (err) {
          console.log("Error occured when reading " + file)
        }
      }
    });
  }
  return pkgConfigs;
}

function probeMoonBitModule(): { modConfig: MoonModConfig, pkgConfigs: Array<MoonPkgConfig> } {
  const cwd = process.cwd();
  const modJsonPath = path.join(cwd, "moon.mod.json");
  if (fs.existsSync(modJsonPath)) {
    const json = JSON.parse(fs.readFileSync(modJsonPath).toString())
    const modConfig: MoonModConfig = {
      source: json.source ? json.source : ".",
      modPath: json.name
    };
    const pkgConfigs: Array<MoonPkgConfig> = probeMoonBitPackage(path.join(cwd, modConfig.source), modConfig);
    return { modConfig, pkgConfigs }
  } else {
    throw new Error("Cannot found MoonBit module (moon.mod.json file) in " + cwd);
  }
}

export default function rabbitTEA(mainPackagePath?: string): Plugin {
  const { modConfig, pkgConfigs } = probeMoonBitModule();
  var mainPkgConfig: MoonPkgConfig | undefined = undefined;

  const mainPkgs = pkgConfigs.filter((x) => x.isMain);
  if (mainPkgs.length == 0) {
    throw new Error("Main package not found in current working directory.")
  }

  if (mainPackagePath != undefined) {
    mainPkgConfig = mainPkgs.find((x) => x.relativePath.endsWith(mainPackagePath))
  }

  if (mainPkgConfig == undefined) {
    mainPkgConfig = mainPkgs.pop()!
  }

  let hasError = false;
  let isBuild = false;
  const releaseDir = 'target/js/release/build';
  const debugDir = 'target/js/debug/build';

  // src/index.js
  const tempJsPath = path.join(modConfig.source, 'main.js');
  // src/index.js.map
  const tempSourceMapPath = path.join(modConfig.source, 'main.js.map');

  function outputJsPath(): string {
    const basePath = isBuild ? releaseDir : debugDir;
    return path.join(basePath, mainPkgConfig!.relativePath, mainPkgConfig!.lastPath + ".js");
  }

  function outputSourceMapPath(): string {
    const basePath = isBuild ? releaseDir : debugDir;
    return path.join(basePath, mainPkgConfig!.relativePath, mainPkgConfig!.lastPath + ".js.map");
  }

  const runMoonbitBuild = () => {
    const result = spawnSync('moon', ['build', '--target', 'js', isBuild ? '--release' : '--debug']);
    if (result.status == 0) {
      cpSync(outputJsPath(), tempJsPath);
      // Only copy source map if it exists (release builds don't generate source maps)
      const sourceMapPath = outputSourceMapPath();
      if (fs.existsSync(sourceMapPath)) {
        cpSync(sourceMapPath, tempSourceMapPath);
      }
      hasError = false;
    } else {
      hasError = true;
      throw new Error(result.stdout.toString() + result.stderr)
    }
  };

  function reportError(err: string, server: ViteDevServer) {
    let errMsg = err.split('\n').slice(1).join('\n');
    server.ws.send({
      type: 'error',
      err: {
        message: errMsg,
        stack: '',
        id: 'rabbitTEA-build',
        plugin: 'vite-plugin-moonbit'
      }
    });
  }


  return {
    name: 'vite-plugin-moonbit',

    config(config, { command }) {
      if (command === 'build') {
        isBuild = true;
      } else {
        isBuild = false;
      }
    },

    buildStart() {
      try {
        runMoonbitBuild();
      } catch (err: any) {
        console.log('buildStart error', err);
      }
    },

    handleHotUpdate({ server, modules, timestamp }) {
      const mods = modules.filter(({ file }) =>
        !(file?.endsWith('.js') && file == path.resolve(tempJsPath)
          || file?.endsWith('.map') && file == path.resolve(tempSourceMapPath))
      )
      if (mods.length === 0) {
        return [];
      }
      try {
        runMoonbitBuild();


        server.ws.send({ type: 'full-reload', path: '*' })
        return []
      } catch (err: any) {
        reportError(err.toString(), server);
        return []
      }
    },

    // const mainJs = server.moduleGraph.getModuleById("/main.js");
    // if (mainJs) server.moduleGraph.invalidateModule(mainJs);
    // const mainJsMap = server.moduleGraph.getModuleById("/main.js.map");
    // if (mainJsMap) server.moduleGraph.invalidateModule(mainJsMap);
    // resolveId(id) {
    //   if (id === '/main.js') return id;
    //   if (id === '/main.js.map' && !isBuild) return id;
    // },

    // load(id) {
    //   if (id === '/main.js') {
    //     let outputPath =
    //       isBuild
    //         ? 'target/js/release/build/main/main.js'
    //         : 'target/js/debug/build/main/main.js';
    //     if (existsSync(outputPath)) {
    //       return readFileSync(outputPath, 'utf-8');
    //     }
    //     return '';
    //   }
    //   if (id === '/main.js.map' && !isBuild) {
    //     let outputPath = 'target/js/debug/build/main/main.js.map';
    //     if (existsSync(outputPath)) {
    //       return readFileSync(outputPath, 'utf-8');
    //     }
    //     return '';
    //   }
    // }
  };
}