import Breadcrumb from "@src/components/Breadcrumb";

const BreadcrumbItem = Breadcrumb.Item;
export const renderBreadcrumb = (filepath: string) => {
  if (!filepath) return null;
  const parts = filepath.split("/");

  if (parts.length <= 3) {
    return parts.map((item: string, index: number) => (
      <BreadcrumbItem key={index}>{item}</BreadcrumbItem>
    ));
  } else {
    return (
      <div className="flex items-center">
        <Breadcrumb separator="/">
          <BreadcrumbItem key="first">{parts[0]}</BreadcrumbItem>
          <BreadcrumbItem key="second">{parts[1]}</BreadcrumbItem>
          <BreadcrumbItem key="ellipsis">...</BreadcrumbItem>
          <BreadcrumbItem key="last">
            <strong>{parts[parts.length - 1]}</strong>
          </BreadcrumbItem>
        </Breadcrumb>
      </div>
    );
  }
};
