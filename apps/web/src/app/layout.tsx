import "./globals.css";
import { Toaster } from "sonner";

export const metadata = {
  title: "Pixshar",
  description: "Private event photo sharing",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,12..72,300;0,12..72,400;0,12..72,500;1,12..72,300&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ fontFamily: "'Geist', system-ui, -apple-system, sans-serif" }}>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
