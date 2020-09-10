// Copyright (C) 2020  zawys. Licensed under AGPL-3.0-or-later.
// See LICENSE file in repository root directory.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFilePromise } from "./childProcessHandy";
import { DiffedURIs } from "./diffedURIs";
import { DiffFileSelector } from "./diffFileSelector";
import { DiffLayouterManager } from "./diffLayouterManager";
import { getVSCGitPathInteractively } from "./getPathsWithinVSCode";
import { extensionID } from "./iDs";
import { Lazy } from "./lazy";
import { readonlyFileURI } from "./readonlyDocumentProvider";
import { RegisterableService } from "./registerableService";

export class ArbitraryFilesMerger implements RegisterableService {
  public register(): void {
    this.disposables = [
      vscode.commands.registerCommand(
        mergeArbitraryFilesCommandID,
        this.mergeArbitraryFiles.bind(this)
      ),
    ];
  }

  public dispose(): void {
    for (const disposabe of this.disposables) {
      disposabe.dispose();
    }
  }

  public async mergeArbitraryFiles(): Promise<boolean> {
    const selectionResult = await this.diffFileSelectorLazy.value.doSelection();
    if (selectionResult === undefined) {
      return false;
    }
    const gitPath = await getVSCGitPathInteractively();
    if (gitPath === undefined) {
      return false;
    }
    const mergedPath = selectionResult.merged.fsPath;
    if (selectionResult.merged.validationResult?.emptyLoc === true) {
      const gitResult = await execFilePromise({
        filePath: gitPath,
        arguments_: [
          "merge-file",
          "--stdout",
          selectionResult.local.fsPath,
          selectionResult.base.fsPath,
          selectionResult.remote.fsPath,
        ],
        options: {
          cwd: path.dirname(mergedPath),
          timeout: 10000,
          windowsHide: true,
        },
      });
      const error = gitResult.error;
      if (
        error !== null &&
        (error.code === undefined || error.code < 0 || error.code > 127)
      ) {
        void vscode.window.showErrorMessage(
          `Error when merging files by Git: ${gitResult.stderr}.`
        );
        return false;
      }
      if (
        !(await new Promise((resolve) =>
          fs.writeFile(mergedPath, gitResult.stdout, (error) =>
            resolve(error === null)
          )
        ))
      ) {
        return false;
      }
    }
    const diffedURIs: DiffedURIs = new DiffedURIs(
      readonlyFileURI(selectionResult.base.fsPath),
      readonlyFileURI(selectionResult.local.fsPath),
      readonlyFileURI(selectionResult.remote.fsPath),
      vscode.Uri.file(selectionResult.merged.fsPath)
    );
    return await this.diffLayouterManager.openDiffedURIs(diffedURIs, false);
  }

  public constructor(
    private readonly diffLayouterManager: DiffLayouterManager,
    private diffFileSelectorLazy = new Lazy(() => new DiffFileSelector())
  ) {}

  private disposables: vscode.Disposable[] = [];
}

const mergeArbitraryFilesCommandID = `${extensionID}.mergeArbitraryFiles`;
