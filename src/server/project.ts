/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts"/>
/// <reference path="scriptInfo.ts"/>
/// <reference path="lshost.ts"/>

namespace ts.server {
    export enum ProjectKind {
        Inferred,
        Configured,
        External
    }

    export abstract class Project {
        private rootFiles: ScriptInfo[] = [];
        private readonly rootFilesMap: FileMap<ScriptInfo> = createFileMap<ScriptInfo>();
        private lsHost: ServerLanguageServiceHost;
        private program: ts.Program;

        languageService: LanguageService;

        /**
         * Set of files that was returned from the last call to getChangesSinceVersion.
         */
        private lastReportedFileNames: Map<string>;
        /**
         * Last version that was reported.
         */
        private lastReportedVersion = 0;
        /**
         * Current project structure version.
         * This property is changed in 'updateGraph' based on the set of files in program
         */
        private projectStructureVersion = 0;
        /**
         * Current version of the project state. It is changed when:
         * - new root file was added/removed
         * - edit happen in some file that is currently included in the project.
         * This property is different from projectStructureVersion since in most cases edits don't affect set of files in the project
         */
        private projectStateVersion = 0;

        constructor(
            readonly projectKind: ProjectKind,
            readonly projectService: ProjectService,
            private documentRegistry: ts.DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            public languageServiceEnabled: boolean,
            private compilerOptions: CompilerOptions) {

            if (!this.compilerOptions) {
                this.compilerOptions = ts.getDefaultCompilerOptions();
                this.compilerOptions.allowNonTsExtensions = true;
                this.compilerOptions.allowJs = true;
            }
            else if (hasExplicitListOfFiles) {
                // If files are listed explicitly, allow all extensions
                this.compilerOptions.allowNonTsExtensions = true;
            }

            if (languageServiceEnabled) {
                this.enableLanguageService();
            }
            else {
                this.disableLanguageService();
            }
            this.markAsDirty();
        }

        getProjectVersion() {
            return this.projectStateVersion.toString();
        }

        enableLanguageService() {
            const lsHost = new LSHost(this.projectService.host, this, this.projectService.cancellationToken);
            lsHost.setCompilationSettings(this.compilerOptions);
            this.languageService = ts.createLanguageService(lsHost, this.documentRegistry);

            this.lsHost = lsHost;
            this.languageServiceEnabled = true;
        }

        disableLanguageService() {
            this.languageService = nullLanguageService;
            this.lsHost = nullLanguageServiceHost;
            this.languageServiceEnabled = false;
        }

        abstract getProjectName(): string;

        close() {
            for (const fileName of this.getFileNames()) {
                const info = this.projectService.getScriptInfoForNormalizedPath(fileName);
                info.detachFromProject(this);
            }
            // signal language service to release files acquired from document registry
            this.languageService.dispose();
        }

        getCompilerOptions() {
            return this.compilerOptions;
        }

        getRootFiles() {
            return this.rootFiles.map(info => info.fileName);
        }

        getFileNames() {
            if (!this.program) {
                return [];
            }

            if (!this.languageServiceEnabled) {
                // if language service is disabled assume that all files in program are root files + default library
                let rootFiles = this.getRootFiles();
                if (this.compilerOptions) {
                    const defaultLibrary = getDefaultLibFilePath(this.compilerOptions);
                    if (defaultLibrary) {
                        (rootFiles || (rootFiles = [])).push(asNormalizedPath(defaultLibrary));
                    }
                }
                return rootFiles;
            }
            const sourceFiles = this.program.getSourceFiles();
            return sourceFiles.map(sourceFile => asNormalizedPath(sourceFile.fileName));
        }

        containsScriptInfo(info: ScriptInfo): boolean {
            return this.program && this.program.getSourceFileByPath(info.path) !== undefined;
        }

        containsFile(filename: NormalizedPath, requireOpen?: boolean) {
            const info = this.projectService.getScriptInfoForNormalizedPath(filename);
            if (info) {
                if ((!requireOpen) || info.isOpen) {
                    return this.containsScriptInfo(info);
                }
            }
        }

        isRoot(info: ScriptInfo) {
            return this.rootFilesMap.contains(info.path);
        }

        // add a root file to project
        addRoot(info: ScriptInfo) {
            if (!this.isRoot(info)) {
                this.rootFiles.push(info);
                this.rootFilesMap.set(info.path, info);
                info.attachToProject(this);
                
                this.markAsDirty();
            }
        }

        removeFile(info: ScriptInfo, detachFromProject: boolean = true) {
            if (!this.removeRoot(info)) {
                this.removeReferencedFile(info)
            }
            if (detachFromProject) {
                info.detachFromProject(this);
            }
            this.markAsDirty();
        }

        markAsDirty() {
            this.projectStateVersion++;
        }

        updateGraph() {
            if (!this.languageServiceEnabled) {
                return;
            }

            const oldProgram = this.program;
            this.program = this.languageService.getProgram();

            // bump up the version if
            // - oldProgram is not set - this is a first time updateGraph is called
            // - newProgram is different from the old program and structure of the old program was not reused.
            if (!oldProgram || (this.program !== oldProgram && !oldProgram.structureIsReused)) {
                this.projectStructureVersion++;
            }
        }

        getScriptInfoForNormalizedPath(fileName: NormalizedPath) {
            const scriptInfo = this.projectService.getOrCreateScriptInfoForNormalizedPath(fileName, /*openedByClient*/ false);
            if (scriptInfo && scriptInfo.attachToProject(this)) {
                this.markAsDirty();
            }
            return scriptInfo;
        }

        getScriptInfo(uncheckedFileName: string) {
            return this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
        }

        filesToString() {
            if (!this.program) {
                return "";
            }
            let strBuilder = "";
            for (const file of this.program.getSourceFiles()) {
                strBuilder += `${file.fileName}\n`;
            }
            return strBuilder;
        }

        setCompilerOptions(compilerOptions: CompilerOptions) {
            if (compilerOptions) {
                compilerOptions.allowNonTsExtensions = true;
                this.compilerOptions = compilerOptions;
                this.lsHost.setCompilationSettings(compilerOptions);

                this.markAsDirty();
            }
        }

        saveTo(filename: string, tmpfilename: string) {
            const script = this.getScriptInfo(filename);
            if (script) {
                const snap = script.snap();
                this.projectService.host.writeFile(tmpfilename, snap.getText(0, snap.getLength()));
            }
        }

        reloadScript(filename: NormalizedPath, cb: () => void) {
            const script = this.getScriptInfoForNormalizedPath(filename);
            if (script) {
                script.reloadFromFile(filename, cb);
            }
        }

        getChangesSinceVersion(lastKnownVersion?: number): protocol.ProjectFiles {
            const info = {
                projectName: this.getProjectName(),
                version: this.projectStructureVersion,
                isInferred: this.projectKind === ProjectKind.Inferred
            };
            // check if requested version is the same that we have reported last time
            if (this.lastReportedFileNames && lastKnownVersion === this.lastReportedVersion) {
                // if current structure version is the same - return info witout any changes
                if (this.projectStructureVersion == this.lastReportedVersion) {
                    return { info };
                }
                // compute and return the difference
                const lastReportedFileNames = this.lastReportedFileNames;
                const currentFiles = arrayToMap(this.getFileNames(), x => x);

                const added: string[] = [];
                const removed: string[] = [];
                for (const id in currentFiles) {
                    if (hasProperty(currentFiles, id) && !hasProperty(lastReportedFileNames, id)) {
                        added.push(id);
                    }
                }
                for (const id in lastReportedFileNames) {
                    if (hasProperty(lastReportedFileNames, id) && !hasProperty(currentFiles, id)) {
                        removed.push(id);
                    }
                }
                this.lastReportedFileNames = currentFiles;

                this.lastReportedFileNames = currentFiles;
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, changes: { added, removed } };
            }
            else {
                // unknown version - return everything
                const projectFileNames = this.getFileNames();
                this.lastReportedFileNames = arrayToMap(projectFileNames, x => x);
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, files: projectFileNames };
            }
        }

        // remove a root file from project
        private removeRoot(info: ScriptInfo): boolean {
            if (this.isRoot(info)) {
                this.rootFiles = copyListRemovingItem(info, this.rootFiles);
                this.rootFilesMap.remove(info.path);
                this.lsHost.removeRoot(info);
                return true;
            }
            return false;
        }

        private removeReferencedFile(info: ScriptInfo) {
            this.lsHost.removeReferencedFile(info)
        }
    }

    export class InferredProject extends Project {

        private static NextId = 1;

        /**
         * Unique name that identifies this particular inferred project
         */
        private readonly inferredProjectName: string;

        // Used to keep track of what directories are watched for this project
        directoriesWatchedForTsconfig: string[] = [];

        constructor(projectService: ProjectService, documentRegistry: ts.DocumentRegistry, languageServiceEnabled: boolean) {
            super(ProjectKind.Inferred,
                projectService,
                documentRegistry,
                /*files*/ undefined,
                languageServiceEnabled,
                /*compilerOptions*/ undefined);

            this.inferredProjectName = makeInferredProjectName(InferredProject.NextId++);
        }

        getProjectName() {
            return this.inferredProjectName;
        }

        close() {
            super.close();

            for (const directory of this.directoriesWatchedForTsconfig) {
                this.projectService.stopWatchingDirectory(directory);
            }
        }
    }

    export class ConfiguredProject extends Project {
        private projectFileWatcher: FileWatcher;
        private directoryWatcher: FileWatcher;
        private directoriesWatchedForWildcards: Map<FileWatcher>;
        /** Used for configured projects which may have multiple open roots */
        openRefCount = 0;

        constructor(readonly configFileName: NormalizedPath,
            projectService: ProjectService,
            documentRegistry: ts.DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            compilerOptions: CompilerOptions,
            private wildcardDirectories: Map<WatchDirectoryFlags>,
            languageServiceEnabled: boolean) {
            super(ProjectKind.Configured, projectService, documentRegistry, hasExplicitListOfFiles, languageServiceEnabled, compilerOptions);
        }

        getProjectName() {
            return this.configFileName;
        }

        watchConfigFile(callback: (project: ConfiguredProject) => void) {
            this.projectFileWatcher = this.projectService.host.watchFile(this.configFileName, _ => callback(this));
        }

        watchConfigDirectory(callback: (project: ConfiguredProject, path: string) => void) {
            if (this.directoryWatcher) {
                return;
            }

            const directoryToWatch = getDirectoryPath(this.configFileName);
            this.projectService.log(`Add recursive watcher for: ${directoryToWatch}`);
            this.directoryWatcher = this.projectService.host.watchDirectory(directoryToWatch, path => callback(this, path), /*recursive*/ true);
        }

        watchWildcards(callback: (project: ConfiguredProject, path: string) => void) {
            if (!this.wildcardDirectories) {
                return;
            }
            const configDirectoryPath = getDirectoryPath(this.configFileName);
            this.directoriesWatchedForWildcards = reduceProperties(this.wildcardDirectories, (watchers, flag, directory) => {
                if (comparePaths(configDirectoryPath, directory, ".", !this.projectService.host.useCaseSensitiveFileNames) !== Comparison.EqualTo) {
                    const recursive = (flag & WatchDirectoryFlags.Recursive) !== 0;
                    this.projectService.log(`Add ${recursive ? "recursive " : ""}watcher for: ${directory}`);
                    watchers[directory] = this.projectService.host.watchDirectory(
                        directory,
                        path => callback(this, path),
                        recursive
                    );
                }
                return watchers;
            }, <Map<FileWatcher>>{});
        }

        stopWatchingDirectory() {
            if (this.directoryWatcher) {
                this.directoryWatcher.close();
                this.directoryWatcher = undefined;
            }
        }

        close() {
            super.close();

            if (this.projectFileWatcher) {
                this.projectFileWatcher.close();
            }

            forEachValue(this.directoriesWatchedForWildcards, watcher => { watcher.close(); });
            this.directoriesWatchedForWildcards = undefined;

            this.stopWatchingDirectory();
        }

        addOpenRef() {
            this.openRefCount++;
        }

        deleteOpenRef() {
            this.openRefCount--;
            return this.openRefCount;
        }
    }

    export class ExternalProject extends Project {
        constructor(readonly externalProjectName: string,
            projectService: ProjectService,
            documentRegistry: ts.DocumentRegistry,
            compilerOptions: CompilerOptions,
            languageServiceEnabled: boolean) {
            super(ProjectKind.External, projectService, documentRegistry, /*hasExplicitListOfFiles*/ true, languageServiceEnabled, compilerOptions);
        }

        getProjectName() {
            return this.externalProjectName;
        }
    }
}