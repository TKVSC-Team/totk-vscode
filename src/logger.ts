import * as vscode from 'vscode';
import * as path from 'path';

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warning = 2,
    Error = 3
}

class ExtensionLogger {
    private outputChannel: vscode.OutputChannel | undefined;

    /**
     * Initialize the Output Channel with built-in "log" language ID for native colorization.
     */
    public init(context: vscode.ExtensionContext) {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('TKVSC', 'log');
            context.subscriptions.push(this.outputChannel);
        }
        this.info('TKVSC: Logger initialized.');
    }

    private getLogLevel(): LogLevel {
        try {
            const config = vscode.workspace.getConfiguration('TKVSC');
            const levelStr = config.get<string>('logLevel', 'Info');
            switch (levelStr) {
                case 'Debug': return LogLevel.Debug;
                case 'Info': return LogLevel.Info;
                case 'Warning': return LogLevel.Warning;
                case 'Error': return LogLevel.Error;
                default: return LogLevel.Info;
            }
        } catch {
            return LogLevel.Info;
        }
    }

    private shouldShowToast(): boolean {
        try {
            const config = vscode.workspace.getConfiguration('TKVSC');
            return config.get<boolean>('enableToastNotifications', true);
        } catch {
            return true;
        }
    }

    private formatMessage(level: string, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }

    public showProcessingToast(filePath: string) {
        try {
            const filename = path.basename(filePath);
            const dotIndex = filename.indexOf('.');
            const filetype = dotIndex !== -1 ? filename.substring(dotIndex) : 'file';
            this.info(`TKVSC: Processing (${filetype})... - ${filePath}`);
        } catch {
            // ignore
        }
    }

    public showSavedToast(filePath: string) {
        try {
            const filename = path.basename(filePath);
            const dotIndex = filename.indexOf('.');
            const filetype = dotIndex !== -1 ? filename.substring(dotIndex) : 'file';
            this.info(`TKVSC: Saved (${filetype}) - ${filePath}`);
        } catch {
            // ignore
        }
    }

    public debug(message: string, ...args: any[]) {
        if (this.getLogLevel() <= LogLevel.Debug) {
            this.write('DEBUG', message, args);
        }
    }

    public info(message: string, ...args: any[]) {
        if (this.getLogLevel() <= LogLevel.Info) {
            this.write('INFO', message, args);
        }
    }

    public warn(message: string, ...args: any[]) {
        if (this.getLogLevel() <= LogLevel.Warning) {
            this.write('WARN', message, args);
            if (this.shouldShowToast()) {
                const formatted = args.length ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}` : message;
                void vscode.window.showWarningMessage(`TKVSC: ${formatted}`);
            }
        }
    }

    public error(message: string | Error, ...args: any[]) {
        const errMessage = message instanceof Error ? message.message : String(message);
        const stack = message instanceof Error && message.stack ? `\nStack trace:\n${message.stack}` : '';
        if (this.getLogLevel() <= LogLevel.Error) {
            this.write('ERROR', `${errMessage}${stack}`, args);
            if (this.shouldShowToast()) {
                const formatted = args.length ? `${errMessage} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}` : errMessage;
                void vscode.window.showErrorMessage(`TKVSC: ${formatted}`);
            }
        }
    }

    private write(level: string, message: string, args: any[]) {
        const formatted = this.formatMessage(level, message);
        let fullMsg = formatted;
        if (args.length) {
            fullMsg += ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        }
        
        // Write to dev console
        if (level === 'ERROR') {
            console.error(fullMsg);
        } else if (level === 'WARN') {
            console.warn(fullMsg);
        } else {
            console.log(fullMsg);
        }

        // Write to Output Channel
        if (this.outputChannel) {
            this.outputChannel.appendLine(fullMsg);
        }
    }

    public show() {
        this.outputChannel?.show(true);
    }
}

export const logger = new ExtensionLogger();
