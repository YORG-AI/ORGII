/**
 * FileTypeIcon Configuration
 *
 * Icon imports and mappings for file type detection.
 *
 * Icons are imported as asset URLs (`?url`) and rendered through `<img>`.
 * As svgr components each of the 152 glyphs was its own JS module in the
 * boot graph; as URLs they cost one short string apiece.
 * Extracted from component to keep UI code minimal.
 */
// ============================================
// SVG Icon Imports
// ============================================
import AndroidIcon from "@src/assets/fileTypeIcons/android.svg?url";
import AngularIcon from "@src/assets/fileTypeIcons/angular.svg?url";
import ApplescriptIcon from "@src/assets/fileTypeIcons/applescript.svg?url";
import ArduinoIcon from "@src/assets/fileTypeIcons/arduino.svg?url";
import AssemblyIcon from "@src/assets/fileTypeIcons/assembly.svg?url";
import AstroIcon from "@src/assets/fileTypeIcons/astro.svg?url";
import AudioIcon from "@src/assets/fileTypeIcons/audio.svg?url";
import BabelIcon from "@src/assets/fileTypeIcons/babel.svg?url";
import CIcon from "@src/assets/fileTypeIcons/c.svg?url";
import ClojureIcon from "@src/assets/fileTypeIcons/clojure.svg?url";
import CmakeIcon from "@src/assets/fileTypeIcons/cmake.svg?url";
import CobolIcon from "@src/assets/fileTypeIcons/cobol.svg?url";
import CoffeeIcon from "@src/assets/fileTypeIcons/coffee.svg?url";
import CommandIcon from "@src/assets/fileTypeIcons/command.svg?url";
import CppIcon from "@src/assets/fileTypeIcons/cpp.svg?url";
import CrystalIcon from "@src/assets/fileTypeIcons/crystal.svg?url";
import CsharpIcon from "@src/assets/fileTypeIcons/csharp.svg?url";
import CssIcon from "@src/assets/fileTypeIcons/css.svg?url";
import CucumberIcon from "@src/assets/fileTypeIcons/cucumber.svg?url";
import CudaIcon from "@src/assets/fileTypeIcons/cuda.svg?url";
import CypressIcon from "@src/assets/fileTypeIcons/cypress.svg?url";
import DIcon from "@src/assets/fileTypeIcons/d.svg?url";
import DartIcon from "@src/assets/fileTypeIcons/dart.svg?url";
import DatabaseIcon from "@src/assets/fileTypeIcons/database.svg?url";
import DiffFileTypeIcon from "@src/assets/fileTypeIcons/diff.svg?url";
import DjangoIcon from "@src/assets/fileTypeIcons/django.svg?url";
import DockerIcon from "@src/assets/fileTypeIcons/docker.svg?url";
import DocumentIcon from "@src/assets/fileTypeIcons/document.svg?url";
import EditorConfigIcon from "@src/assets/fileTypeIcons/editorconfig.svg?url";
import EjsIcon from "@src/assets/fileTypeIcons/ejs.svg?url";
import ElixirIcon from "@src/assets/fileTypeIcons/elixir.svg?url";
import ElmIcon from "@src/assets/fileTypeIcons/elm.svg?url";
import ErlangIcon from "@src/assets/fileTypeIcons/erlang.svg?url";
import EsbuildIcon from "@src/assets/fileTypeIcons/esbuild.svg?url";
import EslintIcon from "@src/assets/fileTypeIcons/eslint.svg?url";
import ExcelIcon from "@src/assets/fileTypeIcons/excel.svg?url";
import ExeIcon from "@src/assets/fileTypeIcons/exe.svg?url";
import FigmaIcon from "@src/assets/fileTypeIcons/figma.svg?url";
import FirebaseIcon from "@src/assets/fileTypeIcons/firebase.svg?url";
import FolderBaseIcon from "@src/assets/fileTypeIcons/folder-base.svg?url";
import FontIcon from "@src/assets/fileTypeIcons/font.svg?url";
import FortranIcon from "@src/assets/fileTypeIcons/fortran.svg?url";
import FsharpIcon from "@src/assets/fileTypeIcons/fsharp.svg?url";
import GatsbyIcon from "@src/assets/fileTypeIcons/gatsby.svg?url";
import GitIcon from "@src/assets/fileTypeIcons/git.svg?url";
import GoIcon from "@src/assets/fileTypeIcons/go.svg?url";
import GradleIcon from "@src/assets/fileTypeIcons/gradle.svg?url";
import GraphqlIcon from "@src/assets/fileTypeIcons/graphql.svg?url";
import GroovyIcon from "@src/assets/fileTypeIcons/groovy.svg?url";
import GruntIcon from "@src/assets/fileTypeIcons/grunt.svg?url";
import GulpIcon from "@src/assets/fileTypeIcons/gulp.svg?url";
import HIcon from "@src/assets/fileTypeIcons/h.svg?url";
import HamlIcon from "@src/assets/fileTypeIcons/haml.svg?url";
import HandlebarsIcon from "@src/assets/fileTypeIcons/handlebars.svg?url";
import HaskellIcon from "@src/assets/fileTypeIcons/haskell.svg?url";
import HaxeIcon from "@src/assets/fileTypeIcons/haxe.svg?url";
import HelmIcon from "@src/assets/fileTypeIcons/helm.svg?url";
import HppIcon from "@src/assets/fileTypeIcons/hpp.svg?url";
import HtmlIcon from "@src/assets/fileTypeIcons/html.svg?url";
import HttpIcon from "@src/assets/fileTypeIcons/http.svg?url";
import ImageIcon from "@src/assets/fileTypeIcons/image.svg?url";
import JavaIcon from "@src/assets/fileTypeIcons/java.svg?url";
import JsIcon from "@src/assets/fileTypeIcons/javascript.svg?url";
import JestIcon from "@src/assets/fileTypeIcons/jest.svg?url";
import JinjaIcon from "@src/assets/fileTypeIcons/jinja.svg?url";
import JsonIcon from "@src/assets/fileTypeIcons/json.svg?url";
import JuliaIcon from "@src/assets/fileTypeIcons/julia.svg?url";
import JupyterIcon from "@src/assets/fileTypeIcons/jupyter.svg?url";
import KeyIcon from "@src/assets/fileTypeIcons/key.svg?url";
import KotlinIcon from "@src/assets/fileTypeIcons/kotlin.svg?url";
import KubernetesIcon from "@src/assets/fileTypeIcons/kubernetes.svg?url";
import LessIcon from "@src/assets/fileTypeIcons/less.svg?url";
import LispIcon from "@src/assets/fileTypeIcons/lisp.svg?url";
import LockIcon from "@src/assets/fileTypeIcons/lock.svg?url";
import LogIcon from "@src/assets/fileTypeIcons/log.svg?url";
import LuaIcon from "@src/assets/fileTypeIcons/lua.svg?url";
import MakefileIcon from "@src/assets/fileTypeIcons/makefile.svg?url";
import MarkdownIcon from "@src/assets/fileTypeIcons/markdown.svg?url";
import MatlabIcon from "@src/assets/fileTypeIcons/matlab.svg?url";
import MavenIcon from "@src/assets/fileTypeIcons/maven.svg?url";
import MdxIcon from "@src/assets/fileTypeIcons/mdx.svg?url";
import NginxIcon from "@src/assets/fileTypeIcons/nginx.svg?url";
import NimIcon from "@src/assets/fileTypeIcons/nim.svg?url";
import NixIcon from "@src/assets/fileTypeIcons/nix.svg?url";
import NpmIcon from "@src/assets/fileTypeIcons/npm.svg?url";
import NuxtIcon from "@src/assets/fileTypeIcons/nuxt.svg?url";
import ObjectiveCIcon from "@src/assets/fileTypeIcons/objective-c.svg?url";
import OcamlIcon from "@src/assets/fileTypeIcons/ocaml.svg?url";
import PdfIcon from "@src/assets/fileTypeIcons/pdf.svg?url";
import PerlIcon from "@src/assets/fileTypeIcons/perl.svg?url";
import PhpIcon from "@src/assets/fileTypeIcons/php.svg?url";
import PlaywrightIcon from "@src/assets/fileTypeIcons/playwright.svg?url";
import PnpmIcon from "@src/assets/fileTypeIcons/pnpm.svg?url";
import PostcssIcon from "@src/assets/fileTypeIcons/postcss.svg?url";
import PowerpointIcon from "@src/assets/fileTypeIcons/powerpoint.svg?url";
import PowershellIcon from "@src/assets/fileTypeIcons/powershell.svg?url";
import PrettierIcon from "@src/assets/fileTypeIcons/prettier.svg?url";
import PrismaIcon from "@src/assets/fileTypeIcons/prisma.svg?url";
import PrologIcon from "@src/assets/fileTypeIcons/prolog.svg?url";
import ProtoIcon from "@src/assets/fileTypeIcons/proto.svg?url";
import PugIcon from "@src/assets/fileTypeIcons/pug.svg?url";
import PurescriptIcon from "@src/assets/fileTypeIcons/purescript.svg?url";
import PythonIcon from "@src/assets/fileTypeIcons/python.svg?url";
import RIcon from "@src/assets/fileTypeIcons/r.svg?url";
import RacketIcon from "@src/assets/fileTypeIcons/racket.svg?url";
import RcIcon from "@src/assets/fileTypeIcons/rc.svg?url";
import ReactIcon from "@src/assets/fileTypeIcons/react.svg?url";
import ReactTsIcon from "@src/assets/fileTypeIcons/react_ts.svg?url";
import ReadmeIcon from "@src/assets/fileTypeIcons/readme.svg?url";
import ReasonIcon from "@src/assets/fileTypeIcons/reason.svg?url";
import RubyIcon from "@src/assets/fileTypeIcons/ruby.svg?url";
import RustIcon from "@src/assets/fileTypeIcons/rust.svg?url";
import SassIcon from "@src/assets/fileTypeIcons/sass.svg?url";
import ScalaIcon from "@src/assets/fileTypeIcons/scala.svg?url";
import SchemeIcon from "@src/assets/fileTypeIcons/scheme.svg?url";
import ConfigIcon from "@src/assets/fileTypeIcons/settings.svg?url";
import SolidityIcon from "@src/assets/fileTypeIcons/solidity.svg?url";
import SqlIcon from "@src/assets/fileTypeIcons/sql.svg?url";
import StorybookIcon from "@src/assets/fileTypeIcons/storybook.svg?url";
import StylelintIcon from "@src/assets/fileTypeIcons/stylelint.svg?url";
import StylusIcon from "@src/assets/fileTypeIcons/stylus.svg?url";
import SvelteIcon from "@src/assets/fileTypeIcons/svelte.svg?url";
import SvgIcon from "@src/assets/fileTypeIcons/svg.svg?url";
import SvgrIcon from "@src/assets/fileTypeIcons/svgr.svg?url";
import SwaggerIcon from "@src/assets/fileTypeIcons/swagger.svg?url";
import SwiftIcon from "@src/assets/fileTypeIcons/swift.svg?url";
import TailwindIcon from "@src/assets/fileTypeIcons/tailwindcss.svg?url";
import TauriIcon from "@src/assets/fileTypeIcons/tauri.svg?url";
import TerraformIcon from "@src/assets/fileTypeIcons/terraform.svg?url";
import TestJsIcon from "@src/assets/fileTypeIcons/test-js.svg?url";
import TestTsIcon from "@src/assets/fileTypeIcons/test-ts.svg?url";
import TexIcon from "@src/assets/fileTypeIcons/tex.svg?url";
import TwigIcon from "@src/assets/fileTypeIcons/twig.svg?url";
import TsDefIcon from "@src/assets/fileTypeIcons/typescript-def.svg?url";
import TsIcon from "@src/assets/fileTypeIcons/typescript.svg?url";
import ValaIcon from "@src/assets/fileTypeIcons/vala.svg?url";
import VercelIcon from "@src/assets/fileTypeIcons/vercel.svg?url";
import VerilogIcon from "@src/assets/fileTypeIcons/verilog.svg?url";
import VideoIcon from "@src/assets/fileTypeIcons/video.svg?url";
import VimIcon from "@src/assets/fileTypeIcons/vim.svg?url";
import ViteIcon from "@src/assets/fileTypeIcons/vite.svg?url";
import VitestIcon from "@src/assets/fileTypeIcons/vitest.svg?url";
import VlangIcon from "@src/assets/fileTypeIcons/vlang.svg?url";
import VueIcon from "@src/assets/fileTypeIcons/vue.svg?url";
import WasmIcon from "@src/assets/fileTypeIcons/webassembly.svg?url";
import WebpackIcon from "@src/assets/fileTypeIcons/webpack.svg?url";
import WordIcon from "@src/assets/fileTypeIcons/word.svg?url";
import XmlIcon from "@src/assets/fileTypeIcons/xml.svg?url";
import YamlIcon from "@src/assets/fileTypeIcons/yaml.svg?url";
import YarnIcon from "@src/assets/fileTypeIcons/yarn.svg?url";
import ZigIcon from "@src/assets/fileTypeIcons/zig.svg?url";
import ZipIcon from "@src/assets/fileTypeIcons/zip.svg?url";

import type { FileType } from "./types";

// ============================================
// Default/Fallback Icon Export
// ============================================

export { DocumentIcon };

// ============================================
// Icon Map
// ============================================

/** Maps file types to their corresponding SVG asset URLs */
export const ICON_MAP: Record<FileType, string> = {
  python: PythonIcon,
  javascript: JsIcon,
  typescript: TsIcon,
  "typescript-def": TsDefIcon,
  markdown: MarkdownIcon,
  mdx: MdxIcon,
  json: JsonIcon,
  html: HtmlIcon,
  css: CssIcon,
  scss: SassIcon,
  sass: SassIcon,
  less: LessIcon,
  stylus: StylusIcon,
  postcss: PostcssIcon,
  jsx: ReactIcon,
  tsx: ReactTsIcon,
  java: JavaIcon,
  kotlin: KotlinIcon,
  scala: ScalaIcon,
  groovy: GroovyIcon,
  c: CIcon,
  cpp: CppIcon,
  h: HIcon,
  hpp: HppIcon,
  csharp: CsharpIcon,
  fsharp: FsharpIcon,
  go: GoIcon,
  rust: RustIcon,
  php: PhpIcon,
  ruby: RubyIcon,
  shell: CommandIcon,
  powershell: PowershellIcon,
  yaml: YamlIcon,
  xml: XmlIcon,
  sql: SqlIcon,
  swift: SwiftIcon,
  vue: VueIcon,
  svelte: SvelteIcon,
  react: ReactIcon,
  "react-ts": ReactTsIcon,
  angular: AngularIcon,
  test: TestJsIcon,
  "test-ts": TestTsIcon,
  config: ConfigIcon,
  rc: RcIcon,
  docker: DockerIcon,
  git: GitIcon,
  lua: LuaIcon,
  perl: PerlIcon,
  r: RIcon,
  julia: JuliaIcon,
  jupyter: JupyterIcon,
  dart: DartIcon,
  elixir: ElixirIcon,
  erlang: ErlangIcon,
  haskell: HaskellIcon,
  clojure: ClojureIcon,
  lisp: LispIcon,
  scheme: SchemeIcon,
  racket: RacketIcon,
  ocaml: OcamlIcon,
  reason: ReasonIcon,
  purescript: PurescriptIcon,
  elm: ElmIcon,
  nim: NimIcon,
  zig: ZigIcon,
  crystal: CrystalIcon,
  d: DIcon,
  fortran: FortranIcon,
  cobol: CobolIcon,
  assembly: AssemblyIcon,
  wasm: WasmIcon,
  solidity: SolidityIcon,
  graphql: GraphqlIcon,
  proto: ProtoIcon,
  terraform: TerraformIcon,
  hcl: TerraformIcon,
  nginx: NginxIcon,
  cmake: CmakeIcon,
  makefile: MakefileIcon,
  gradle: GradleIcon,
  maven: MavenIcon,
  npm: NpmIcon,
  pnpm: PnpmIcon,
  yarn: YarnIcon,
  eslint: EslintIcon,
  prettier: PrettierIcon,
  stylelint: StylelintIcon,
  babel: BabelIcon,
  webpack: WebpackIcon,
  vite: ViteIcon,
  vitest: VitestIcon,
  jest: JestIcon,
  cypress: CypressIcon,
  playwright: PlaywrightIcon,
  storybook: StorybookIcon,
  prisma: PrismaIcon,
  tailwind: TailwindIcon,
  svg: SvgIcon,
  svgr: SvgrIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  font: FontIcon,
  folder: FolderBaseIcon,
  pdf: PdfIcon,
  word: WordIcon,
  excel: ExcelIcon,
  document: DocumentIcon,
  powerpoint: PowerpointIcon,
  "pages-doc": WordIcon,
  zip: ZipIcon,
  lock: LockIcon,
  log: LogIcon,
  env: ConfigIcon,
  key: KeyIcon,
  readme: ReadmeIcon,
  license: DocumentIcon,
  android: AndroidIcon,
  kubernetes: KubernetesIcon,
  helm: HelmIcon,
  firebase: FirebaseIcon,
  vercel: VercelIcon,
  tauri: TauriIcon,
  nuxt: NuxtIcon,
  gatsby: GatsbyIcon,
  nix: NixIcon,
  vim: VimIcon,
  tex: TexIcon,
  prolog: PrologIcon,
  matlab: MatlabIcon,
  "objective-c": ObjectiveCIcon,
  verilog: VerilogIcon,
  vala: ValaIcon,
  vlang: VlangIcon,
  haml: HamlIcon,
  pug: PugIcon,
  ejs: EjsIcon,
  jinja: JinjaIcon,
  twig: TwigIcon,
  handlebars: HandlebarsIcon,
  haxe: HaxeIcon,
  arduino: ArduinoIcon,
  cuda: CudaIcon,
  toml: ConfigIcon,
  editorconfig: EditorConfigIcon,
  http: HttpIcon,
  swagger: SwaggerIcon,
  astro: AstroIcon,
  applescript: ApplescriptIcon,
  coffee: CoffeeIcon,
  django: DjangoIcon,
  database: DatabaseIcon,
  diff: DiffFileTypeIcon,
  exe: ExeIcon,
  figma: FigmaIcon,
  grunt: GruntIcon,
  gulp: GulpIcon,
  cucumber: CucumberIcon,
  esbuild: EsbuildIcon,
  other: DocumentIcon,
};
