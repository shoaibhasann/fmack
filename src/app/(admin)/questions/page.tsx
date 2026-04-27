import Link from 'next/link';

export default function QuestionsPage() {
  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Questions</h1>
        <Link
          href="/questions/create"
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
        >
          Add Question
        </Link>
      </div>
      <p className="text-gray-500">Question list table will be built here.</p>
    </div>
  );
}
