// Copyright (C) 2020  zawys. Licensed under AGPL-3.0-or-later.
// See LICENSE file in repository root directory.

import { readFile } from "fs";
import {
  Disposable,
  window,
  commands,
  Event,
  EventEmitter,
  StatusBarItem,
  StatusBarAlignment,
  MessageItem,
} from "vscode";
import { DiffedURIs } from "./diffedURIs";
import { copy } from "./fsHandy";
import { extensionID } from "./ids";
import {
  DiffLayouter,
  DiffLayouterFactory,
  focusNextConflictCommandID,
  focusPreviousConflictCommandID,
  SearchType,
} from "./layouters/diffLayouter";
import { FourTransferDownLayouterFactory } from "./layouters/fourTransferDownLayouter";
import { FourTransferRightLayouterFactory } from "./layouters/fourTransferRightLayouter";
import { ThreeDiffToBaseLayouterFactory } from "./layouters/threeDiffToBaseLayouter";
import { ThreeDiffToBaseMergedRightLayouterFactory } from "./layouters/threeDiffToBaseMergedRightLayouter";
import { ThreeDiffToBaseRowsLayouterFactory } from "./layouters/threeDiffToBaseRowsLayouter";
import { ThreeDiffToMergedLayouterFactory } from "./layouters/threeDiffToMergedLayouter";
import { containsMergeConflictIndicators } from "./mergeConflictIndicatorDetector";
import { Monitor } from "./monitor";
import { RegisterableService } from "./registerableService";
import { TemporarySettingsManager } from "./temporarySettingsManager";
import { createUIError, isUIError, UIError } from "./uIError";
import { VSCodeConfigurator } from "./vSCodeConfigurator";
import { Zoom, ZoomManager } from "./zoom";

export class DiffLayouterManager implements RegisterableService {
  public async register(): Promise<void> {
    for (const disposabe of this.disposables) {
      disposabe.dispose();
    }
    this.disposables = [
      commands.registerCommand(
        focusPreviousConflictCommandID,
        this.focusMergeConflictInteractively.bind(this, SearchType.previous)
      ),
      commands.registerCommand(
        focusNextConflictCommandID,
        this.focusMergeConflictInteractively.bind(this, SearchType.next)
      ),
      commands.registerCommand(
        deactivateLayoutCommandID,
        this.deactivateLayout.bind(this)
      ),
      commands.registerCommand(
        resetMergedFileCommandID,
        this.resetMergedFile.bind(this)
      ),
      commands.registerCommand(
        switchLayoutCommandID,
        this.switchLayout.bind(this)
      ),
      this.zoomManager.onWasZoomRequested(
        this.handleWasZoomRequested.bind(this)
      ),
    ];
    await this.temporarySettingsManager.resetSettings();
  }

  public async deactivateLayout(): Promise<void> {
    await this.layouterManagerMonitor.enter();
    try {
      await this.layouter?.deactivate();
      this.layouter = undefined;
      this.layouterFactory = undefined;
    } finally {
      await this.layouterManagerMonitor.leave();
    }
  }

  public async save(): Promise<void> {
    await this.layouter?.save();
  }

  public focusMergeConflict(type: SearchType): UIError | boolean {
    return this.layouter?.isActive === true
      ? this.layouter.focusMergeConflict(type)
      : createUIError("No diff layout active.");
  }

  public focusMergeConflictInteractively(
    type: SearchType
  ): undefined | boolean {
    const result = this.focusMergeConflict(type);
    if (isUIError(result)) {
      void window.showErrorMessage(result.message);
      return undefined;
    } else if (!result) {
      void window.showInformationMessage("No merge conflict found.");
    }
    return result;
  }

  public get onDidLayoutDeactivate(): Event<DiffLayouter> {
    return this.didLayoutDeactivate.event;
  }

  public get onDidLayoutActivate(): Event<DiffLayouter> {
    return this.didLayoutActivate.event;
  }
  public get diffedURIs(): DiffedURIs | undefined {
    return this.layouter?.isActivating || this.layouter?.isActive
      ? this.layouter.diffedURIs
      : undefined;
  }

  public get layoutSwitchInProgress(): boolean {
    return this.layouter !== undefined && !this.layouter.isActive;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.layouter?.dispose();
  }

  public async resetMergedFile(): Promise<void> {
    const diffedURIs = this.diffedURIs;
    if (this.layouter?.isActive === undefined || diffedURIs === undefined) {
      void window.showErrorMessage(
        "Reset not applicable; no merge situation opened."
      );
      return;
    }
    if (diffedURIs?.backup === undefined) {
      void window.showErrorMessage("Backup file is unknown.");
      return;
    }
    const copyResult = await copy(
      diffedURIs.backup.fsPath,
      diffedURIs.merged.fsPath
    );
    if (isUIError(copyResult)) {
      void window.showErrorMessage(
        `Resetting the merged file failed: ${copyResult.message}`
      );
      return;
    }
  }

  public openDiffedURIs(
    diffedURIs: DiffedURIs,
    closeActiveEditor: boolean
  ): Promise<boolean>;
  public async openDiffedURIs(
    diffedURIs: DiffedURIs,
    closeActiveEditor: boolean,
    deactivationHandler?: () => void
  ): Promise<boolean>;
  public async openDiffedURIs(
    diffedURIs: DiffedURIs,
    closeActiveEditor: boolean,
    deactivationHandler?: () => void
  ): Promise<boolean> {
    await this.layouterManagerMonitor.enter();
    try {
      const activeDiffedURIs = this.layouter?.diffedURIs;
      if (
        (this.layouter?.isActivating || this.layouter?.isActive) === true &&
        activeDiffedURIs !== undefined &&
        diffedURIs.equalsWithoutBackup(activeDiffedURIs)
      ) {
        return true;
      }

      const newLayouterFactory = await this.getLayoutFactory();
      if (newLayouterFactory === undefined) {
        return false;
      }

      // point of no return

      if (closeActiveEditor) {
        await this.closeActiveEditor();
      }
      await this.activateLayouter(diffedURIs, newLayouterFactory);
      if (deactivationHandler !== undefined) {
        const result: Disposable | undefined = this.onDidLayoutDeactivate(
          () => {
            deactivationHandler();
            result?.dispose();
          }
        );
      }
    } finally {
      await this.layouterManagerMonitor.leave();
    }
    if (this.layouter !== undefined) {
      this.didLayoutActivate.fire(this.layouter);
    }
    return true;
  }

  public async switchLayout(layoutName?: unknown): Promise<void> {
    if (this.layouter?.diffedURIs === undefined) {
      void window.showErrorMessage(
        "This requires the diff layout to be active"
      );
      return;
    }
    let targetFactory: DiffLayouterFactory | undefined;
    if (typeof layoutName === "string") {
      targetFactory = this.factories.find(
        (factory) => factory.settingValue === layoutName
      );
    }
    if (targetFactory === undefined) {
      const pickResult = await window.showQuickPick(
        this.factories
          .filter((factory) => factory !== this.layouterFactory)
          .map((factory) => factory.settingValue)
      );
      if (pickResult === undefined) {
        return;
      }
      targetFactory = this.factories.find(
        (factory) => factory.settingValue === pickResult
      );
      if (targetFactory === undefined) {
        return;
      }
    }
    if (
      targetFactory === this.layouterFactory ||
      this.layouter?.diffedURIs === undefined
    ) {
      void window.showErrorMessage(
        "The situation has changed meanwhile. Please try again."
      );
    }
    await this.layouterManagerMonitor.enter();
    try {
      await this.activateLayouter(this.layouter.diffedURIs, targetFactory);
    } finally {
      await this.layouterManagerMonitor.leave();
    }
    if (this.layouter !== undefined) {
      this.didLayoutActivate.fire(this.layouter);
    }
  }

  public async closeActiveEditor(): Promise<void> {
    await commands.executeCommand("workbench.action.closeActiveEditor");
  }

  public constructor(
    public readonly vSCodeConfigurator: VSCodeConfigurator,
    public readonly zoomManager: ZoomManager,
    public readonly temporarySettingsManager: TemporarySettingsManager,
    public readonly factories: DiffLayouterFactory[] = [
      new ThreeDiffToMergedLayouterFactory(),
      new ThreeDiffToBaseLayouterFactory(),
      new ThreeDiffToBaseRowsLayouterFactory(),
      new ThreeDiffToBaseMergedRightLayouterFactory(),
      new FourTransferRightLayouterFactory(),
      new FourTransferDownLayouterFactory(),
    ]
  ) {
    if (factories.length === 0) {
      throw new Error("internal error: no factory registered");
    }
    const defaultFactory = factories.find(
      (factory) =>
        factory.settingValue ===
        new FourTransferRightLayouterFactory().settingValue
    );
    if (defaultFactory === undefined) {
      throw new Error("could not find default factory");
    }
    this.defaultFactory = defaultFactory;
  }

  private layouterFactory: DiffLayouterFactory | undefined;
  private layouter: DiffLayouter | undefined;
  private readonly layouterMonitor = new Monitor();
  private readonly layouterManagerMonitor = new Monitor();
  private disposables: Disposable[] = [];
  private readonly defaultFactory: DiffLayouterFactory;
  private readonly didLayoutDeactivate = new EventEmitter<DiffLayouter>();
  private readonly didLayoutActivate = new EventEmitter<DiffLayouter>();
  private switchLayoutStatusBarItem: StatusBarItem | undefined;

  private activateSwitchLayoutStatusBarItem(): void {
    if (this.switchLayoutStatusBarItem !== undefined) {
      return;
    }
    this.switchLayoutStatusBarItem = window.createStatusBarItem(
      StatusBarAlignment.Left,
      5
    );
    this.switchLayoutStatusBarItem.text = "$(editor-layout)";
    this.switchLayoutStatusBarItem.command = switchLayoutCommandID;
    this.switchLayoutStatusBarItem.tooltip = "Switch diff editor layout…";
    this.switchLayoutStatusBarItem.show();
  }

  private deactivateSwitchLayoutStatusBarItem(): void {
    this.switchLayoutStatusBarItem?.dispose();
    this.switchLayoutStatusBarItem = undefined;
  }

  private async activateLayouter(
    diffedURIs: DiffedURIs,
    newLayouterFactory: DiffLayouterFactory
  ): Promise<void> {
    const oldLayouter = this.layouter;
    if (oldLayouter !== undefined) {
      await oldLayouter.deactivate(true);
    }

    this.layouterFactory = newLayouterFactory;
    this.layouter = newLayouterFactory.create({
      monitor: this.layouterMonitor,
      temporarySettingsManager: this.temporarySettingsManager,
      diffedURIs,
      vSCodeConfigurator: this.vSCodeConfigurator,
      zoomManager: this.zoomManager,
    });
    this.layouter.onDidDeactivate(this.handleLayouterDidDeactivate.bind(this));
    await this.layouter.tryActivate(Zoom.default, oldLayouter !== undefined);
    this.activateSwitchLayoutStatusBarItem();
  }

  private async handleLayouterDidDeactivate(layouter: DiffLayouter) {
    this.layouter = undefined;
    this.deactivateSwitchLayoutStatusBarItem();
    this.didLayoutDeactivate.fire(layouter);
    if (!layouter.wasInitiatedByMergetool) {
      const text = await new Promise<string | undefined>((resolve) =>
        readFile(layouter.diffedURIs.merged.fsPath, "utf8", (error, data) =>
          resolve(error ? undefined : data)
        )
      );
      if (text !== undefined && containsMergeConflictIndicators(text)) {
        const reopen = "Reopen";
        const keepClosed = "Keep closed";
        const result = await window.showWarningMessage(
          "Merge conflict markers are included in closed file.",
          reopen,
          keepClosed
        );
        if (
          result === reopen &&
          !(await this.openDiffedURIs(layouter.diffedURIs, false))
        ) {
          void window.showErrorMessage(
            "Opening failed, probably because one of the files was removed."
          );
        }
      }
    }
  }

  private async getLayoutFactory(): Promise<DiffLayouterFactory | undefined> {
    let layoutSetting = this.vSCodeConfigurator.get(layoutSettingID);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      for (const factory of this.factories) {
        if (factory.settingValue === layoutSetting) {
          return factory;
        }
      }
      const restoreItem: MessageItem = {
        title: "Restore default",
      };
      const onceItem: MessageItem = {
        title: "Use default once",
      };
      const cancelItem: MessageItem = { title: "Cancel" };
      const selectedItem = await window.showErrorMessage(
        "Diff layout setting has an unknown value.",
        restoreItem,
        onceItem,
        cancelItem
      );
      if (selectedItem === cancelItem || selectedItem === undefined) {
        return;
      }
      if (selectedItem === restoreItem) {
        await this.vSCodeConfigurator.set(
          layoutSettingID,
          this.defaultFactory.settingValue
        );
      }
      layoutSetting = this.defaultFactory.settingValue;
    }
  }

  private async handleWasZoomRequested(zoom: Zoom): Promise<void> {
    await this.layouterManagerMonitor.enter();
    try {
      if (this.layouterManagerMonitor.someoneIsWaiting) {
        return;
      }
      if (!this.layouter?.isActive) {
        void window.showErrorMessage(
          "Diff layout must be active to use zoom commands."
        );
        return;
      }
      await this.layouter.setLayout(zoom);
    } finally {
      await this.layouterManagerMonitor.leave();
    }
  }
}

export const layoutSettingID = `${extensionID}.layout`;
export const deactivateLayoutCommandID = `${extensionID}.deactivateLayout`;
export const resetMergedFileCommandID = `${extensionID}.resetMergedFile`;
export const switchLayoutCommandID = `${extensionID}.switchLayout`;
