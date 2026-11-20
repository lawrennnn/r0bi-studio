import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Renderer error:', error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-900 p-8 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-ink-300">{this.state.error.message}</p>
        <p className="max-w-md text-ink-300">Your project is safe. Autosaved changes can be recovered when you reopen it.</p>
        <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
