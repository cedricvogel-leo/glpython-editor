import { useEffect, useRef } from 'react'

export type TurtleCommand =
  | { type: 'clear' }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }

export function GraphicsWindow({ commands }: { commands: TurtleCommand[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fbfaf6'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.translate(0, canvas.height)
    context.scale(1, -1)
    for (const command of commands) {
      if (command.type !== 'line') continue
      context.beginPath()
      context.moveTo(command.x1, command.y1)
      context.lineTo(command.x2, command.y2)
      context.strokeStyle = command.color
      context.lineWidth = command.width
      context.lineCap = 'round'
      context.stroke()
    }
    context.restore()
  }, [commands])

  return <canvas className="graphics-canvas" ref={canvasRef} width={640} height={420} aria-label="Turtle graphics output" />
}
