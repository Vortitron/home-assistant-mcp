// The strip under the screen: shows the status line and, once clicked, takes the
// keyboard for the game. A terminal reports presses only; house.wad holds each
// key for a moment and the terminal's auto-repeat keeps it held. Keys go to the
// hooks module in batches, as a Client posts once a frame at most.
import type { ClientModule } from 'claude-code'

type Props = { text: string; hint: string }
type Local = { queue: string[]; isFocused: boolean }

const Keys: ClientModule<Props, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    const local: Local = { queue: [], isFocused: false }
    surface.setState(local)
    surface.onKey(event => {
      if (event.ctrl || event.meta) return
      local.isFocused = true
      local.queue.push(event.key)
    })
    surface.onPointer(event => {
      if (event.type === 'down') local.isFocused = true
    })
    surface.every(30, () => {
      if (local.queue.length > 0) surface.post({ keys: local.queue.splice(0, local.queue.length) })
    })
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{props.text}</Text>
      <Text dimColor wrap="truncate-end">{props.hint}</Text>
    </Box>
  )
}

export default Keys
