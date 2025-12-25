import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppSettings, AppSettingsSchema } from '@vtot/shared';

const SETTINGS_FILE_NAME = 'settings.json';

/**
 * 设置管理类。
 */
export class SettingsManager {
  private settingsPath: string;
  private currentSettings: AppSettings;

  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
    this.currentSettings = AppSettingsSchema.parse({}); // 使用默认值
  }

  /**
   * 加载设置。
   */
  public async load(): Promise<AppSettings> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(content);
      this.currentSettings = AppSettingsSchema.parse(parsed);
    } catch (err) {
      // 文件不存在或格式错误，保持默认值
      console.log('[settings] using default settings');
      await this.save(this.currentSettings);
    }
    return this.currentSettings;
  }

  /**
   * 保存设置。
   */
  public async save(settings: Partial<AppSettings>): Promise<AppSettings> {
    this.currentSettings = AppSettingsSchema.parse({
      ...this.currentSettings,
      ...settings,
    });
    
    await fs.writeFile(
      this.settingsPath, 
      JSON.stringify(this.currentSettings, null, 2), 
      'utf-8'
    );
    return this.currentSettings;
  }

  /**
   * 获取当前设置。
   */
  public get(): AppSettings {
    return this.currentSettings;
  }
}
