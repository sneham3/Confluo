/**
 * Confluo mark. The artwork lives in /brand/confluo-mark.png (black on transparent) and is applied
 * as a CSS mask so it can take any color: `currentColor` by default, or the hero's purple→blue
 * gradient when `gradient` is set. Works on the landing page's black canvas and on light surfaces.
 */
const MARK_URL = '/brand/confluo-mark.png';

export function LogoMark({ size = 28, gradient = false, className }: { size?: number; gradient?: boolean; className?: string }) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    display: 'inline-block',
    flexShrink: 0,
    background: gradient ? 'linear-gradient(135deg, #e07be0 0%, #4f7cff 100%)' : 'currentColor',
    WebkitMaskImage: `url(${MARK_URL})`,
    maskImage: `url(${MARK_URL})`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
  };
  return <span aria-hidden className={className} style={style} />;
}
