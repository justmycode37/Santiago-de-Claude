import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

// No XcodeGen or third-party packages needed on the Mac. Run after resources build.
const root = path.resolve('apps/ios');
const projectDir = path.join(root, 'RightSide.xcodeproj');
await mkdir(path.join(root, 'RightSideTests'), { recursive: true });
// Keep the bridge worker's native conformance source in the hosted test target.
await copyFile('tests/ios/NativeCoreTests.swift', path.join(root, 'RightSideTests/NativeCoreTests.swift')).catch(error => { if (error.code !== 'ENOENT') throw error; });
const id = name => createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase();
const objects = {};
const add = (name, value) => { const key = id(name); objects[key] = value; return key; };
async function files(relative) {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(name));
    else result.push(name);
  }
  return result.sort();
}
const project = id('project');
const products = [];
const groups = [];
const targets = [];
const refs = {};
function fileRef(file) {
  if (refs[file]) return refs[file];
  const ext = path.extname(file);
  refs[file] = add(`file:${file}`, { isa: 'PBXFileReference', lastKnownFileType: ext === '.swift' ? 'sourcecode.swift' : ext === '.js' ? 'sourcecode.javascript' : ext === '.json' ? 'text.json' : ext === '.plist' ? 'text.plist.xml' : 'text', path: file, sourceTree: '<group>' });
  return refs[file];
}
const base = {
  IPHONEOS_DEPLOYMENT_TARGET: '17.0', SWIFT_VERSION: '5.0', SDKROOT: 'iphoneos',
  SUPPORTED_PLATFORMS: 'iphoneos iphonesimulator', TARGETED_DEVICE_FAMILY: '1,2',
  CLANG_ENABLE_MODULES: 'YES', SWIFT_STRICT_CONCURRENCY: 'targeted',
  CODE_SIGN_STYLE: 'Automatic', CURRENT_PROJECT_VERSION: '1', MARKETING_VERSION: '0.1.0',
};
function configurationList(name, extra, isProject = false) {
  const configs = ['Debug', 'Release'].map(configuration => add(`${name}:${configuration}`, {
    isa: 'XCBuildConfiguration', name: configuration,
    buildSettings: {
      ...base, ...extra,
      ...(configuration === 'Debug' ? { SWIFT_OPTIMIZATION_LEVEL: '-Onone', DEBUG_INFORMATION_FORMAT: 'dwarf', ENABLE_TESTABILITY: 'YES', SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG' } : { SWIFT_OPTIMIZATION_LEVEL: '-O', DEBUG_INFORMATION_FORMAT: 'dwarf-with-dsym', SWIFT_COMPILATION_MODE: 'wholemodule' }),
      ...(isProject ? { CLANG_WARN_DOCUMENTATION_COMMENTS: 'YES', GCC_WARN_UNUSED_VARIABLE: 'YES' } : {}),
    },
  }));
  return add(`${name}:configlist`, { isa: 'XCConfigurationList', buildConfigurations: configs, defaultConfigurationIsVisible: '0', defaultConfigurationName: 'Release' });
}
for (const name of ['RightSide', 'RightSideTests', 'RightSideUITests']) {
  const test = name !== 'RightSide', ui = name === 'RightSideUITests';
  const sourceFiles = (await files(name)).filter(file => file.endsWith('.swift'));
  const resourceFiles = test ? [] : (await files('RightSide/Resources')).filter(file => !file.endsWith('.md'));
  const phase = (kind, list) => add(`${name}:${kind}`, {
    isa: `PBX${kind}BuildPhase`, buildActionMask: '2147483647', runOnlyForDeploymentPostprocessing: '0',
    files: list.map(file => add(`${name}:build:${file}`, { isa: 'PBXBuildFile', fileRef: fileRef(file) })),
  });
  const product = add(`${name}:product`, { isa: 'PBXFileReference', explicitFileType: test ? 'wrapper.cfbundle' : 'wrapper.application', includeInIndex: '0', path: test ? `${name}.xctest` : `${name}.app`, sourceTree: 'BUILT_PRODUCTS_DIR' });
  products.push(product);
  groups.push(add(`${name}:group`, { isa: 'PBXGroup', name, children: [...sourceFiles, ...resourceFiles, ...(!test ? ['RightSide/Info.plist'] : [])].map(fileRef), sourceTree: '<group>' }));
  const dependencies = [];
  if (test) {
    const proxy = add(`${name}:proxy`, { isa: 'PBXContainerItemProxy', containerPortal: project, proxyType: '1', remoteGlobalIDString: id('RightSide:target'), remoteInfo: 'RightSide' });
    dependencies.push(add(`${name}:dependency`, { isa: 'PBXTargetDependency', target: id('RightSide:target'), targetProxy: proxy }));
  }
  const target = add(`${name}:target`, {
    isa: 'PBXNativeTarget', name, productName: name, productReference: product,
    productType: test ? ui ? 'com.apple.product-type.bundle.ui-testing' : 'com.apple.product-type.bundle.unit-test' : 'com.apple.product-type.application',
    buildConfigurationList: configurationList(name, {
      PRODUCT_NAME: '$(TARGET_NAME)', PRODUCT_BUNDLE_IDENTIFIER: `org.rightside.${test ? name.toLowerCase() : 'journey'}`,
      GENERATE_INFOPLIST_FILE: test ? 'YES' : 'NO',
      LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks @loader_path/Frameworks',
      ...(test ? ui ? { TEST_TARGET_NAME: 'RightSide' } : { TEST_HOST: '$(BUILT_PRODUCTS_DIR)/RightSide.app/RightSide', BUNDLE_LOADER: '$(TEST_HOST)' } : { INFOPLIST_FILE: 'RightSide/Info.plist', LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks' }),
    }),
    buildPhases: [phase('Sources', sourceFiles), phase('Frameworks', []), phase('Resources', resourceFiles)],
    buildRules: [], dependencies,
  });
  targets.push(target);
}
const productGroup = add('products', { isa: 'PBXGroup', name: 'Products', children: products, sourceTree: '<group>' });
const mainGroup = add('main', { isa: 'PBXGroup', children: [...groups, productGroup], sourceTree: '<group>' });
objects[project] = { isa: 'PBXProject', attributes: { BuildIndependentTargetsInParallel: 'YES', LastUpgradeCheck: '1600', TargetAttributes: Object.fromEntries(targets.map(target => [target, { CreatedOnToolsVersion: '16.0', ...(target !== id('RightSide:target') ? { TestTargetID: id('RightSide:target') } : {}) }])) }, buildConfigurationList: configurationList('project', {}, true), compatibilityVersion: 'Xcode 14.0', developmentRegion: 'en', hasScannedForEncodings: '0', knownRegions: ['en', 'Base'], mainGroup, productRefGroup: productGroup, projectDirPath: '', projectRoot: '', targets };
const quote = value => JSON.stringify(String(value));
function plist(value, depth = 0) {
  if (Array.isArray(value)) return `(${value.map(item => plist(item, depth + 1)).join(', ')})`;
  if (value && typeof value === 'object') return `{\n${Object.entries(value).map(([key, item]) => `${'\t'.repeat(depth + 1)}${quote(key)} = ${plist(item, depth + 1)};`).join('\n')}\n${'\t'.repeat(depth)}}`;
  return quote(value);
}
await mkdir(path.join(projectDir, 'xcshareddata/xcschemes'), { recursive: true });
await writeFile(path.join(projectDir, 'project.pbxproj'), '// !$*UTF8*$!\n' + plist({ archiveVersion: '1', classes: {}, objectVersion: '56', objects, rootObject: project }) + '\n');
const buildRef = name => `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id(`${name}:target`)}" BuildableName="${name === 'RightSide' ? 'RightSide.app' : `${name}.xctest`}" BlueprintName="${name}" ReferencedContainer="container:RightSide.xcodeproj"/>`;
await writeFile(path.join(projectDir, 'xcshareddata/xcschemes/RightSide.xcscheme'), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${buildRef('RightSide')}</BuildActionEntry></BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>${['RightSideTests', 'RightSideUITests'].map(name => `<TestableReference skipped="NO">${buildRef(name)}</TestableReference>`).join('')}</Testables></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${buildRef('RightSide')}</BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${buildRef('RightSide')}</BuildableProductRunnable></ProfileAction>
 <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n`);
console.log(`Generated ${projectDir} (${Object.keys(refs).length} files)`);
