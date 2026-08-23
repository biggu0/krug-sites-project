import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '挂历工房 - 客户定制 PDF 生成器',
  description: '为 A4 挂历自动排列客户图片并生成 300 DPI 加工 PDF。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
