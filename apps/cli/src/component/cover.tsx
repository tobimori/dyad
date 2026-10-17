import { useTheme } from "../theme/theme.ts";
import type { Artwork } from "./use-artwork.ts";

export function Cover(props: {
  readonly artwork: Artwork | null;
  readonly width: number;
  readonly height: number;
}) {
  const theme = useTheme();

  return (
    <box
      width={props.width}
      height={props.height}
      justifyContent="center"
      alignItems="center"
      backgroundColor={props.artwork === null ? theme.selection : theme.panel}
    >
      {props.artwork === null ? (
        <text fg={theme.faint}>♪</text>
      ) : (
        <image source={props.artwork.image} fit="fit" width={props.width} height={props.height} />
      )}
    </box>
  );
}
