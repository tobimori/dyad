import { Option } from "effect";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { commands, keyLabel, useCommands } from "./keymap.ts";
import { useTheme } from "./theme.ts";

function ErrorScreen(props: {
  readonly message: string;
  readonly onRestart: () => void;
  readonly onQuit: () => void;
}) {
  const theme = useTheme();

  useCommands([
    [commands.quit, props.onQuit],
    [commands.reload, props.onRestart],
  ]);

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={theme.background}
    >
      <box flexDirection="column" maxWidth={72} gap={1}>
        <text fg={theme.error}>
          <strong>The player stopped because of an error</strong>
        </text>
        <text fg={theme.muted}>{props.message}</text>
        <text fg={theme.muted}>The log file has the details.</text>
        <text>
          <span fg={theme.accent}>{keyLabel(commands.reload.keys[0] ?? "")}</span>
          <span fg={theme.muted}> restart </span>
          <span fg={theme.accent}>{keyLabel(commands.quit.keys[0] ?? "")}</span>
          <span fg={theme.muted}> quit</span>
        </text>
      </box>
    </box>
  );
}

/** Shows the error instead of a broken screen, with keys to start the app again or to quit */
export class ErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly onError: (cause: unknown, componentStack: string) => void;
    readonly onQuit: () => void;
  },
  { readonly failure: Option.Option<string> }
> {
  override state = { failure: Option.none<string>() };

  static getDerivedStateFromError(cause: unknown) {
    return { failure: Option.some(cause instanceof Error ? cause.message : String(cause)) };
  }

  override componentDidCatch(cause: unknown, info: ErrorInfo) {
    this.props.onError(cause, info.componentStack ?? "");
  }

  override render() {
    if (Option.isNone(this.state.failure)) return this.props.children;

    return (
      <ErrorScreen
        message={this.state.failure.value}
        onRestart={() => this.setState({ failure: Option.none() })}
        onQuit={this.props.onQuit}
      />
    );
  }
}
