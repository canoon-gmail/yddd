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
      Execute(solution: Path[], delta: number): void;
    };
    Clipper: { Orientation(path: Path): boolean; Area(path: Path): number; PointInPolygon(pt: IntPoint, path: Path): number };
    JoinType: { jtRound: number };
    EndType: { etClosedPolygon: number };
  };
  export default ClipperLib;
}
