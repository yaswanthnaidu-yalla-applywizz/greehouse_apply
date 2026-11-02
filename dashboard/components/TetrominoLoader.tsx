/** Full-screen "Checking access" loader using the tetromino animation. */
export function TetrominoLoader() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
      <div className="tetrominos">
        <div className="tetromino box1" />
        <div className="tetromino box2" />
        <div className="tetromino box3" />
        <div className="tetromino box4" />
      </div>
    </main>
  );
}
