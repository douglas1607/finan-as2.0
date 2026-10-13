import { ExtractorConfig } from '../@types/common';
export declare class Config {
    private readonly config;
    private internConfig;
    constructor(config: ExtractorConfig);
    getConfig(): ExtractorConfig;
    sanitizeRow(row: string): string;
    getPartialJsonData(data: string): string;
}
