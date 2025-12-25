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
    
    // 初始化默认值，优先从环境变量读取
    const defaultSettings: Partial<AppSettings> = {};
    if (process.env.VTOT_HF_TOKEN) {
      defaultSettings.hfToken = process.env.VTOT_HF_TOKEN;
    }
    
    this.currentSettings = AppSettingsSchema.parse(defaultSettings);
  }

  /**
   * 加载设置。
   */
  public async load(): Promise<AppSettings> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(content);
      
      // 合并策略：本地文件 > 环境变量 > 默认模型值
      const merged = {
        ...this.currentSettings, // 这里已经包含了构造函数里设置的 .env 默认值
        ...parsed,
      };
      
      this.currentSettings = AppSettingsSchema.parse(merged);
    } catch (err) {
      // 文件不存在或格式错误，保持构造函数中的默认值（含有 .env 项目）
      console.log('[settings] using default settings with .env fallback');
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
