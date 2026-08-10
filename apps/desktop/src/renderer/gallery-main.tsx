import { createRoot } from 'react-dom/client'
import { Gallery } from './gallery.tsx'

// Точка монтирования витрины 2.4. До этого этапа её физически негде было
// посмотреть: рендерер существовал, а окна и бандлера не было вовсе.

const root = document.getElementById('root')
if (root) createRoot(root).render(<Gallery />)
