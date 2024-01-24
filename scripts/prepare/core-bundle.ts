import { dirname, join, parse, posix, relative, sep } from 'path';
import type { Options, defineConfig } from 'tsup';
import { build } from 'tsup';
import dedent from 'ts-dedent';
import { readFile, writeFile } from 'fs/promises';
import { emptyDir, ensureFile } from 'fs-extra';
import sortPkg from 'sort-package-json';
import type { PackageJson } from 'type-fest';
import aliasPlugin from 'esbuild-plugin-alias';

import { globalPackages as globalManagerPackages } from '../../code/core/main/src/modules/manager/globals/globals';

type Flags = {
  watch: boolean;
  optimized: boolean;
  reset: boolean;
  cwd: string;
};

/* MAIN */

const run = async ({ cwd, flags }: { cwd: string; flags: string[] }) => {
  const reset = hasFlag(flags, 'reset');
  const watch = hasFlag(flags, 'watch');
  const optimized = hasFlag(flags, 'optimized');

  const utils = Promise.all([
    import(join(cwd, 'tsup.config.ts')).then((m) =>
      getOptionsArray(m.default.default || m.default)
    ),
    getBaseOptions({ watch, optimized, cwd, reset }),
    readFile(join(cwd, 'package.json'), 'utf-8').then(
      (s) => JSON.parse(s) as PackageJson.PackageJsonStandard
    ),
  ]);

  if (reset) {
    await emptyDir(join(process.cwd(), 'dist'));
  }

  const [configs, { defaults, overrides }, pkg] = await utils;

  const tasks = [];

  if (configs.length < 1) {
    throw new Error('No tsup-configs found');
  }

  // if watch, instead of using native watch, use chokidar + https://esbuild.github.io/api/#rebuild

  tasks.push(...configs.map((config) => build(mergeOptions({ config, overrides, defaults }))));

  const entries = configs.flatMap(({ entry, format: formatRaw }) => {
    if (!entry) {
      return [];
    }
    return [...(Array.isArray(entry) ? entry : Object.values(entry))].flatMap((file) =>
      [].concat(formatRaw).map((format) => ({ file, format }))
    );
  });

  if (!optimized) {
    tasks.push(...entries.map(({ file }) => generateDTSMapperFile(file)));
  }

  tasks.push(
    updatePackageJson(pkg, [
      ...entries,
      {
        file: './src/prebuild/manager/runtime.ts',
        format: 'iife',
      },
      {
        file: './src/prebuild/manager/globals-runtime.ts',
        format: 'iife',
      },
      {
        file: './src/prebuild/preview/globals-runtime.ts',
        format: 'iife',
      },
    ])
  );

  await Promise.all(tasks);

  await build({
    entry: [
      './src/modules/manager/runtime.ts',
      './src/modules/manager/globals-runtime.ts',
      './src/modules/preview/globals-runtime.ts',
    ],
    format: ['esm'],
    external: [],
    config: false,
    clean: false,
    outDir: join(cwd, 'dist/prebuild'),
    outExtension: () => ({
      js: '.js',
    }),
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NODE_DEBUG': '""',
      'process.env.FORCE_SIMILAR_INSTEAD_OF_MAP': '"false"',
    },
    esbuildPlugins: [
      aliasPlugin({
        process: require.resolve('process/browser.js'),
        util: require.resolve('util/util.js'),
      }),
    ],
    target: ['chrome100', 'safari15', 'firefox91'],
  });

  await [
    './src/prebuild/manager/runtime.ts',
    './src/prebuild/manager/globals-runtime.ts',
    './src/prebuild/preview/globals-runtime.ts',
  ].map(async (file) => generateDTSMapperFile(file));

  await build({
    entry: ['./src/modules/core-server/presets/common-manager.ts'],
    format: ['esm'],
    config: false,
    external: [...globalManagerPackages],
    clean: false,
    outDir: join(cwd, 'dist/modules/core-server/presets'),
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NODE_DEBUG': '""',
      'process.env.FORCE_SIMILAR_INSTEAD_OF_MAP': '"false"',
    },
    esbuildPlugins: [
      aliasPlugin({
        process: require.resolve('process/browser.js'),
        util: require.resolve('util/util.js'),
      }),
    ],
    target: ['chrome100', 'safari15', 'firefox91'],
  });

  if (process.env.CI !== 'true') {
    console.log('done');
  }
};

/* UTILS */

async function getOptionsArray(config: ReturnType<typeof defineConfig>): Promise<Options[]> {
  const list = [];
  if (Array.isArray(config)) {
    list.push(...config);
  } else if (typeof config === 'object') {
    list.push(config);
  } else if (typeof config === 'function') {
    list.push(...[].concat(await config({})));
  }

  return list;
}

async function getBaseOptions({
  watch,
  optimized,
  cwd,
}: Flags): Promise<{ defaults: Options; overrides: Options }> {
  return {
    defaults: {
      config: false,
      silent: !watch,
      treeshake: true,
      sourcemap: false,
      shims: false,

      outDir: join(cwd, 'dist'),
      esbuildOptions: (c) =>
        Object.assign(c, {
          outbase: join(cwd, 'src'),
          logLevel: 'error',
          legalComments: 'none',
          minifyWhitespace: optimized,
          minifyIdentifiers: false,
          minifySyntax: optimized,
        }),

      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.NODE_DEBUG': '""',
        'process.env.FORCE_SIMILAR_INSTEAD_OF_MAP': '"false"',
      },
    },
    overrides: {
      watch: !!watch,
      clean: false,
    },
  };
}

function mergeOptions({
  config,
  overrides,
  defaults,
}: {
  config: Options;
  overrides: Options;
  defaults: Options;
}): Options {
  return {
    ...defaults,
    ...config,
    ...overrides,
  };
}

async function generateDTSMapperFile(file: string) {
  const { name: entryName, dir, base } = parse(file);

  const pathName = join(process.cwd(), dir.replace('./src', './dist'), `${entryName}.d.ts`);
  const srcName = join(process.cwd(), dir, base);
  const rel = relative(dirname(pathName), dirname(srcName)).split(sep).join(posix.sep);

  await ensureFile(pathName);
  await writeFile(
    pathName,
    dedent`
      // generated type definitions for dev-mode
      export * from '${rel}/${base}';
    `,
    { encoding: 'utf-8' }
  );
}

const hasFlag = (flags: string[], name: string) => !!flags.find((s) => s.startsWith(`--${name}`));

const formatToType: Record<string, string> = {
  cjs: 'require',
  esm: 'module',
  iife: 'module',
};
const formatToExt: Record<string, string> = {
  cjs: '.js',
  esm: '.mjs',
  iife: '.js',
};

async function updatePackageJson(
  pkg: PackageJson.PackageJsonStandard,
  entries: Record<string, string>[]
) {
  const grouped = entries.reduce<Record<string, Record<string, string>>>(
    (acc, { file, format }) => {
      const type = formatToType[format];
      if (!type) {
        return acc;
      }

      const { dir, name } = parse(file);
      const key = `./${join(dir.replace('./src', './dist'), name)}`;
      acc[key] = acc[key] || {
        types: `${key}.d.ts`,
      };
      acc[key][type] = `${key}${formatToExt[format]}`;
      return acc;
    },
    {}
  );

  if (
    (typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) ||
    pkg.exports === undefined
  ) {
    pkg.exports = {
      './package.json': './package.json',
      // ...(pkg.exports as any),
      ...grouped,
    };
    await writeFile(join(cwd, 'package.json'), `${JSON.stringify(sortPkg(pkg), null, 2)}\n`);
  }
}

/* SELF EXECUTION */

const flags = process.argv.slice(2);
const cwd = process.cwd();

run({ cwd, flags }).catch((err: unknown) => {
  // We can't let the stack try to print, it crashes in a way that sets the exit code to 0.
  // Seems to have something to do with running JSON.parse() on binary / base64 encoded sourcemaps
  // in @cspotcode/source-map-support
  if (err instanceof Error) {
    console.error(err.stack);
  }
  process.exit(1);
});
