export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <aside className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <span className="text-lg font-semibold text-gray-900">FMACK Admin</span>
        </div>
        <nav className="flex-1 px-4 py-4 space-y-1">
          {/* Nav links added once UI is built */}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
