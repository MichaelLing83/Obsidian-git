import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import ObsidianGitPlugin from "./main";

export class ObsidianGitSettingTab extends PluginSettingTab {
  plugin: ObsidianGitPlugin;

  constructor(app: App, plugin: ObsidianGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Git Settings" });

    // ---- Remote configuration ----
    containerEl.createEl("h3", { text: "Remote Repository" });

    new Setting(containerEl)
      .setName("Remote URL")
      .setDesc(
        "HTTPS or SSH URL of the remote repository (e.g. https://github.com/user/repo.git). Leave empty to skip remote operations."
      )
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/user/repo.git")
          .setValue(this.plugin.settings.remoteUrl)
          .onChange(async (value) => {
            this.plugin.settings.remoteUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote name")
      .setDesc('The git remote name, usually "origin".')
      .addText((text) =>
        text
          .setPlaceholder("origin")
          .setValue(this.plugin.settings.remoteName)
          .onChange(async (value) => {
            this.plugin.settings.remoteName = value.trim() || "origin";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("The branch to push to / pull from.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    // ---- Authentication ----
    containerEl.createEl("h3", { text: "Authentication" });

    containerEl.createEl("p", {
      text: "For HTTPS remotes, provide a username and a personal access token (PAT) or password. For SSH remotes, leave these fields empty and rely on your system SSH agent/key.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your git hosting username (e.g. GitHub username). Used only for HTTPS remotes.")
      .addText((text) =>
        text
          .setPlaceholder("username")
          .setValue(this.plugin.settings.authUsername)
          .onChange(async (value) => {
            this.plugin.settings.authUsername = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Personal access token / password")
      .setDesc(
        "Your personal access token or password. This is stored in the plugin data file — keep your vault private."
      )
      .addText((text) => {
        text
          .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        return text;
      });

    new Setting(containerEl)
      .setName("Apply remote URL")
      .setDesc("Update the git remote to the URL configured above.")
      .addButton((btn) =>
        btn
          .setButtonText("Apply")
          .setCta()
          .onClick(async () => {
            const { remoteUrl, remoteName } = this.plugin.settings;
            if (!remoteUrl) {
              new Notice("Remote URL is empty. Nothing to apply.");
              return;
            }
            try {
              await this.plugin.gitManager.setRemote(remoteName, remoteUrl);
              new Notice(`Remote "${remoteName}" set to: ${remoteUrl}`);
            } catch (e) {
              new Notice(`Failed to set remote: ${(e as Error).message}`);
            }
          })
      );

    // ---- Commit settings ----
    containerEl.createEl("h3", { text: "Commit" });

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc('Template for commit messages. Use "{{date}}" to insert the current date/time.')
      .addText((text) =>
        text
          .setPlaceholder("vault backup: {{date}}")
          .setValue(this.plugin.settings.commitMessageTemplate)
          .onChange(async (value) => {
            this.plugin.settings.commitMessageTemplate = value || "vault backup: {{date}}";
            await this.plugin.saveSettings();
          })
      );

    // ---- Pull strategy ----
    containerEl.createEl("h3", { text: "Pull / Sync" });

    new Setting(containerEl)
      .setName("Pull strategy")
      .setDesc("How to integrate remote changes: merge (creates a merge commit) or rebase (replays local commits on top).")
      .addDropdown((drop) =>
        drop
          .addOption("merge", "Merge")
          .addOption("rebase", "Rebase")
          .setValue(this.plugin.settings.pullStrategy)
          .onChange(async (value) => {
            this.plugin.settings.pullStrategy = value as "merge" | "rebase";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pull before push")
      .setDesc("Automatically pull remote changes before pushing.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pullBeforePush)
          .onChange(async (value) => {
            this.plugin.settings.pullBeforePush = value;
            await this.plugin.saveSettings();
          })
      );

    // ---- Auto-commit ----
    containerEl.createEl("h3", { text: "Auto-commit" });

    new Setting(containerEl)
      .setName("Enable auto-commit")
      .setDesc("Automatically stage and commit changes on a schedule.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoCommitEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoCommitEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.setupAutoCommit();
          })
      );

    new Setting(containerEl)
      .setName("Auto-commit interval (minutes)")
      .setDesc("How often to auto-commit. Minimum 1 minute.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 120, 1)
          .setValue(this.plugin.settings.autoCommitIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.autoCommitIntervalMinutes = value;
            await this.plugin.saveSettings();
            this.plugin.setupAutoCommit();
          })
      );

    new Setting(containerEl)
      .setName("Auto-push after commit")
      .setDesc("Automatically push to the remote after each (auto-)commit.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoPushOnCommit)
          .onChange(async (value) => {
            this.plugin.settings.autoPushOnCommit = value;
            await this.plugin.saveSettings();
          })
      );

    // ---- UI ----
    containerEl.createEl("h3", { text: "Interface" });

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc("Display git status (branch, ahead/behind) in the Obsidian status bar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBar = value;
            await this.plugin.saveSettings();
            this.plugin.updateStatusBarVisibility();
          })
      );
  }
}
