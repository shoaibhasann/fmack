type Props = { params: Promise<{ id: string }> };

export default async function ViewQuestionPage({ params }: Props) {
  const { id } = await params;
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900">View Question</h1>
      <p className="mt-2 text-gray-500 font-mono text-sm">ID: {id}</p>
    </div>
  );
}
