/** clipper-lib (Clipper 6, Angus Johnson — 2D polygon offset / booleans): the parts YDDD uses. */
declare module "clipper-lib" {
  interface IntPoint {
    X: number;
    Y: number;
  }
  type Path = IntPoint[];
  const ClipperLib: {
    ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => {
      AddPath(path: Path, join: number, end: number): void;
      AddPaths(paths: Path[], join: number, end: number): void;
      Execute(solution: Path[], delta: number): void;
    };
    Clipper: {
      new (): { AddPaths(paths: Path[], polyType: number, closed: boolean): void; Execute(clipType: number, solution: Path[], subjFill: number, clipFill: number): boolean };
      Orientation(path: Path): boolean;
      Area(path: Path): number;
      PointInPolygon(pt: IntPoint, path: Path): number;
    };
    ClipType: { ctDifference: number; ctUnion: number };
    PolyType: { ptSubject: number; ptClip: number };
    PolyFillType: { pftNonZero: number; pftPositive: number };
    JoinType: { jtRound: number; jtMiter: number };
    EndType: { etClosedPolygon: number };
  };
  export default ClipperLib;
}
