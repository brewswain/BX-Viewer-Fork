import type { Metadata } from 'next'
import Link from 'next/link'
import SiteHeader from '@/components/SiteHeader'

export const metadata: Metadata = {
  title: 'About — BounceX Viewer',
}

export default function AboutPage() {
  return (
    <>
      <SiteHeader active="about" />

      <main className="main-content">
        <div className="about-layout">
          <div className="about-hero">
            <div className="about-logo">
              Bounce
              <span>X</span>
              Viewer
            </div>
            <p className="about-tagline">A .bx file and video player.</p>
          </div>

          <div className="about-grid">
            <div className="about-card">
              <div className="about-card-title">What is this?</div>
              <div className="about-card-body">
                <p>
                  BounceX Viewer is a self-hosted, web-based player for BounceX
                  .bx files. It lets you watch videos and playlists synchronized
                  with their BounceX path data in real time, from any device on
                  your network.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">What is BounceX?</div>
              <div className="about-card-body">
                <p>
                  BounceX is a beat marker creation and rendering tool.
                  <br />
                  The accompanying paths represent the depth at which to insert a
                  dildo. When the ball reaches the top, insert all the way in, and
                  at the bottom, remove or nearly remove the dildo.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">How to use</div>
              <div className="about-card-body">
                <p>
                  Open the <Link href="/manager">Manager</Link> and drag in a .zip
                  containing a package, then hard refresh (ctrl + shift + R) to
                  see the changes and watch new videos in the browse tab.
                </p>
                <p>
                  The Manager also validates every folder, so it&apos;s the
                  fastest way to find a package that&apos;s put together wrong.
                  The README covers the package layout if you&apos;re building
                  one by hand.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">Credits</div>
              <div className="about-card-body">
                <p>
                  This is a private fork of Alunacoz&apos;s BounceX Viewer,
                  rebuilt on Next.js and TypeScript. All credit for the original
                  app and its design goes there. BounceX itself is by Optiacku.
                </p>
                <p>
                  Charts and videos are by their respective creators. This site
                  is created mostly by generative AI.
                </p>
              </div>
            </div>

            <div className="about-card about-card-wide">
              <div className="about-card-title">Links</div>
              <div className="about-card-body">
                <div className="about-links">
                  <a href="https://discord.gg/Y8YdgmH8Ka" className="about-link">
                    <span className="about-link-label">Dildo Hero Discord</span>
                  </a>
                  <a
                    href="https://github.com/clbhundley/BounceX"
                    className="about-link"
                  >
                    <span className="about-link-label">BounceX (Optiacku)</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
